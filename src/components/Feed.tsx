import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, cover, fmt, fmtTime, isMobile } from "../api";
import type { Detail, Episode, Post, VideoCard } from "../types";
import { useStore } from "../store";
import { Avatar, Img, Sheet } from "./ui";
import VideoSurface, { type VideoHandle } from "./VideoSurface";
import PlayerControls from "./PlayerControls";
import PlaybackLock from "./PlaybackLock";
import { ArticlePanel, CommentsPanel, EpisodesPanel } from "./Panels";
import { setBackHandler } from "../back";
import {
  IBack, IBoltF, IChevR, IChevronDown, IChevronUp, IClose, ICommentF, ICompress, IExpand, IFileText, IHeart, IHeartF,
  ILink, IList, ILockF, IPauseF, IPlayF, ISearch, IStar, IStarF, IVol, IVolMute,
} from "../icons";

type Props = {
  videoIds: number[];
  startIndex?: number;
  title?: string;
  mode: "home" | "context";
  kind?: "video" | "post";
  active: boolean;
  bottomInset: number;
  onBack?: () => void;
  onNearEnd?: () => void;
  /** 从观看记录续播：起始集数与秒数 */
  startEp?: number;
  startTime?: number;
};

export default function Feed({ videoIds, startIndex = 0, title = "", mode, kind = "video", active, bottomInset, onBack, onNearEnd, startEp, startTime }: Props) {
  const store = useStore();
  const { isLiked, isFav, toggleLikeLocal, toggleFavLocal, toggleFollowLocal, muted, setMuted, volume, setVolume, toast, addHistory, user, setSeriesOpen } = store;
  const isDesktop = !isMobile;

  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<VideoHandle>(null);
  /* 上下滑时旧槽位的 ref 会先被置空。忽略 null，避免滑向上一条时把手柄清掉。 */
  const bindVideo = useCallback((handle: VideoHandle | null) => {
    if (handle) videoRef.current = handle;
  }, []);
  const [index, setIndex] = useState(startIndex);
  const [epMap, setEpMap] = useState<Record<number, number>>(() => (startEp ? { [videoIds[startIndex]]: startEp } : {}));
  const [details, setDetails] = useState<Record<number, Detail>>({});
  const [playUrls, setPlayUrls] = useState<Record<string, string>>({});
  const [cards] = useState<Record<number, VideoCard>>({});
  const [posts, setPosts] = useState<Record<number, Post>>({});
  /* 红果式全集模式：锁定一部剧，上下滑切换集数 */
  const [seriesMode, setSeriesMode] = useState(false);
  const [seriesVideoId, setSeriesVideoId] = useState<number | null>(null);
  const [epIndex, setEpIndex] = useState(0);

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vsize, setVsize] = useState({ w: 0, h: 0 });
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(false);
  const [controlsLocked, setControlsLocked] = useState(false);
  const [rate, setRate] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState("");
  /* 取播放地址失败后手动重试：递增即重新触发拉取 */
  const [playTry, setPlayTry] = useState(0);
  const [panel, setPanel] = useState<"episodes" | "comments" | "article" | "detail" | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  /* 续播：拿到时长后再 seek 一次（只对进入时那一条生效） */
  const resumeRef = useRef<{ key: string; t: number } | null>(
    startTime && startTime > 1 ? { key: `${videoIds[startIndex]}:${startEp || 1}`, t: startTime } : null,
  );
  /* 观看进度：onTime 里节流写回 store，卸载时再兜一次 */
  const liveRef = useRef({ id: 0, ep: 1, dur: 0, t: 0 });
  const lastSaveRef = useRef(0);
  const theater = store.theater;
  const setTheater = store.setTheater;
  const fs = store.fs;
  const setFs = store.setFs;
  const clean = store.clean;
  const setClean = store.setClean;

  /* 追踪手机视口是否已处于物理/系统横屏状态（window.innerWidth > window.innerHeight） */
  const [vpLandscape, setVpLandscape] = useState(
    () => typeof window !== "undefined" && window.innerWidth > window.innerHeight,
  );

  /* 单击清屏 vs 双击暂停计时器 */
  const lastTapRef = useRef<{ time: number; timer: number | null }>({ time: 0, timer: null });
  const clearTapTimer = () => {
    if (lastTapRef.current.timer) {
      window.clearTimeout(lastTapRef.current.timer);
      lastTapRef.current.timer = null;
    }
  };

  /* 桌面：鼠标闲置 2.8s 自动隐藏播放器 UI（沉浸） */
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  }, []);
  useEffect(() => {
    if (!isDesktop) return undefined;
    wake();
    return () => window.clearTimeout(idleTimer.current);
  }, [isDesktop, wake]);
  useEffect(() => {
    if (paused) { setIdle(false); window.clearTimeout(idleTimer.current); }
  }, [paused]);
  const [fullscreen, setFullscreen] = useState(false);
  const [heartBurst, setHeartBurst] = useState(0);
  /* 红果式双击点赞：屏幕上飘心 */
  const [floatHearts, setFloatHearts] = useState<{ id: number; x: number; y: number }[]>([]);
  const heartIdRef = useRef(0);
  /* —— 移动端手势 & 竖屏横片缩放 —— */
  const [holdSpeed, setHoldSpeed] = useState(false);
  const [speedLock, setSpeedLock] = useState(false);
  const [lockArmed, setLockArmed] = useState(false);
  const holdRef = useRef(false);
  const lockArmedRef = useRef(false);
  const [scrub, setScrub] = useState<{ pct: number; target: number } | null>(null);
  const scrubTarget = useRef<number | null>(null);
  /* 竖屏下横屏视频适应模式 + 双指无级缩放/平移 */
  const [portraitFit, setPortraitFit] = useState<"contain" | "cover">("contain");
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0, gesturing: false });
  const pinchRef = useRef<{
    dist0: number; midX0: number; midY0: number; scale0: number; x0: number; y0: number;
  } | null>(null);
  /* 进度条拖动 */
  const barScrub = useRef(false);
  const [barPct, setBarPct] = useState<number | null>(null);
  const gesture = useRef<{
    x: number; y: number; startX: number; startY: number; t: number; timer: number | null;
    mode: "idle" | "hold" | "scrub" | "pan"; base: number; width: number; playing: boolean;
  } | null>(null);

  const seriesEps = (seriesVideoId != null ? details[seriesVideoId]?.episodes : undefined) || [];
  const curId = seriesMode && seriesVideoId != null ? seriesVideoId : videoIds[index];
  const detail = details[curId];
  const episodes = detail?.episodes || [];
  const curEp = seriesMode
    ? (seriesEps[epIndex]?.ep_num || epMap[curId] || 1)
    : (epMap[curId] || 1);
  const playKey = `${curId}:${curEp}`;
  const playUrl = playUrls[playKey] || "";
  useEffect(() => { videoRef.current?.trace("page.active", { active, view: mode, video_id: curId, episode: curEp, series_mode: seriesMode }); }, [active, mode, curId, curEp, seriesMode]);
  const post = posts[curId];

  /* 观看进度：onTime 里每 5 秒落一次；拖动进度条期间忽略底层 timeupdate 防止进度条回跳 */
  const onTimeTick = (t: number) => {
    liveRef.current = { id: curId, ep: curEp, dur: duration, t };
    if (!barScrub.current && gesture.current?.mode !== "scrub") {
      setTime(t);
    }
    const now = Date.now();
    if (duration > 0 && now - lastSaveRef.current > 5000) {
      lastSaveRef.current = now;
      addHistory(curId, curEp, t, duration);
    }
  };

  /* 拿到时长后再续播：只对进入时那一条生效，且不跳到片尾 */
  const onDurationTick = (d: number) => {
    setDuration(d);
    liveRef.current = { ...liveRef.current, dur: d };
    const r = resumeRef.current;
    if (r && r.key === playKey && r.t > 1 && (!d || r.t < d - 3)) {
      resumeRef.current = null;
      videoRef.current?.seek(r.t, "history_resume");
      setTime(r.t);
    }
  };

  /** 统一视图模型：短剧与吃瓜帖子共用同一套播放界面 */
  const meta = kind === "post"
    ? {
        title: post?.title || "",
        cover: post?.cover || "",
        desc: post?.content || post?.desc || "",
        author: "黄果吃瓜",
        authorId: -1,
        tags: post?.tags || [],
        score: 0,
        like: 0,
        comment: 0,
        collect: 0,
        episodes: [] as Episode[],
      }
    : {
        title: detail?.title || cards[curId]?.title || "",
        cover: detail?.cover || cards[curId]?.cover || "",
        desc: detail?.description || "",
        author: detail?.author?.name || "黄果短剧",
        authorId: detail?.author?.id || -1,
        tags: detail?.tags || [],
        score: detail?.score || 0,
        like: detail?.counts?.like ?? cards[curId]?.like_count ?? 0,
        comment: detail?.counts?.comment ?? cards[curId]?.comment_count ?? 0,
        collect: detail?.counts?.collect ?? cards[curId]?.collect_count ?? 0,
        episodes: detail?.episodes || [],
      };

  const posterUrl = cover(meta.cover, 900);
  const hasVideo = kind === "video" || !!post?.video_url;
  const articleHtml = kind === "post" && !hasVideo ? (post?.content || "") : "";

  /* 分享：复制播放链接 */
  const shareLink = () => {
    const u = kind === "post" ? (posts[curId]?.video_url || meta.title) : `https://huangguoai.com/video/${curId}/`;
    navigator.clipboard?.writeText(u).then(() => toast("链接已复制", "ok")).catch(() => {});
  };

  /* 倍速：长按 / 锁定 → 2.0x，否则用基准倍速 */
  const effRate = holdSpeed || speedLock ? 2 : rate;
  /* 进度条显示百分比（拖动时用拖动值） */
  const barProgress = barPct ?? (duration ? time / duration : 0);
  /* 是否为横屏视频（16:9 等宽大于高） */
  const isLandscapeVideo = vsize.w > vsize.h && vsize.h > 0;
  /* 仅当「全屏 + 横屏视频 + 手机系统视口尚未横过来 (!vpLandscape)」时才用 CSS 旋转 90° 兜底；
     一旦系统屏幕已经横过来了 (vpLandscape === true)，不再叠加 CSS 旋转，彻底解决手机横置后视频反而竖过去的问题！ */
  const rotated = !isDesktop && fs && isLandscapeVideo && !vpLandscape;

  /* 借鉴 stclock1988/hghub-ios (PlayerView.swift keepPlayingThroughTransition)：
     iOS 在横竖屏几何旋转或全屏视图层级切换期间，系统底层 AVPlayer / WebKit 视频层可能被短暂挂起暂停。
     在过渡窗口期内分批重申 play()，确保旋转/全屏切换不中断播放。 */
  const keepPlayingTimers = useRef<number[]>([]);
  const keepPlayingThroughTransition = useCallback(() => {
    keepPlayingTimers.current.forEach((id) => window.clearTimeout(id));
    keepPlayingTimers.current = [];
    const el = videoRef.current?.el();
    const shouldPlay = el ? !el.paused : !paused;
    if (!shouldPlay) return;
    for (const delay of [50, 150, 300, 500, 800, 1200]) {
      const tid = window.setTimeout(() => {
        const v = videoRef.current?.el();
        if (v && v.paused && !v.ended) {
          videoRef.current?.play();
        }
      }, delay);
      keepPlayingTimers.current.push(tid);
    }
  }, [paused]);

  useEffect(() => () => {
    keepPlayingTimers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  /* 监听手机屏幕横竖屏变化：物理横置手机时自动进入全屏，竖回时自动退出全屏 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const onViewportChange = () => {
      const isLand = window.innerWidth > window.innerHeight;
      setVpLandscape((prev) => {
        if (prev !== isLand && active) {
          setFs(isLand);
          keepPlayingThroughTransition();
        }
        return isLand;
      });
    };
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, [isDesktop, active, setFs, keepPlayingThroughTransition]);

  /* 进入 / 退出全屏：对横屏视频直接调用原生屏幕方向切换，让手机系统界面真正横过来 */
  const enterFs = useCallback(() => {
    keepPlayingThroughTransition();
    setClean(false);
    setFs(true);
    if (isLandscapeVideo) {
      invoke("set_orientation", { landscape: true }).catch(() => {});
      try {
        (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.("landscape")?.catch(() => {});
      } catch { /* ignore */ }
    }
  }, [isLandscapeVideo, setClean, setFs, keepPlayingThroughTransition]);

  const exitFs = useCallback(() => {
    keepPlayingThroughTransition();
    setClean(false);
    setFs(false);
    invoke("set_orientation", { landscape: false }).catch(() => {});
    try { screen.orientation?.unlock?.(); } catch { /* ignore */ }
  }, [setClean, setFs, keepPlayingThroughTransition]);

  /* 全屏状态下若视频宽高刚加载出来且为横屏，自动补发一次横屏指令 */
  useEffect(() => {
    if (!isDesktop && fs && isLandscapeVideo) {
      invoke("set_orientation", { landscape: true }).catch(() => {});
    }
  }, [isDesktop, fs, isLandscapeVideo]);

  /* 全屏切换或视口旋转后校准滚动容器 scrollTop：
     - 进入全屏时非当前项已隐藏，当前项位于顶部 scrollTop = 0；
     - 退出全屏回到竖屏列表时，立即将 scrollTop 重新对齐到当前槽位，防止错位。
     上下滑本身由 scroll-snap 落位。这里若跟着 index 再写 scrollTop，
     会在滑动过半时把列表拽到终点，画面闪一下。 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    if (fs) {
      el.scrollTop = 0;
      return undefined;
    }
    const slot = seriesMode ? epIndex : index;
    const syncScroll = () => {
      const box = boxRef.current;
      if (!box || fs) return;
      box.scrollTop = slot * (box.clientHeight || 1);
    };
    syncScroll();
    const raf = requestAnimationFrame(syncScroll);
    const t1 = window.setTimeout(syncScroll, 120);
    const t2 = window.setTimeout(syncScroll, 350);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
    // index / epIndex 只在全屏或旋转当帧读取，不能放进依赖，否则每次翻页都会打断滑动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs, vpLandscape]);

  /* 滚动定位（全屏或缩放手势期间锁定索引，避免容器尺寸变化误触发翻页） */
  const onScroll = useCallback(() => {
    if (fs || pinchRef.current) return;
    const el = boxRef.current;
    if (!el) return;
    const h = el.clientHeight || 1;
    const len = seriesMode ? Math.max(seriesEps.length, 1) : videoIds.length;
    const i = Math.max(0, Math.min(len - 1, Math.round(el.scrollTop / h)));
    if (seriesMode) {
      setEpIndex((prev) => {
        if (prev === i) return prev;
        const ep = seriesEps[i]?.ep_num;
        if (ep && seriesVideoId != null) setEpMap((m) => ({ ...m, [seriesVideoId]: ep }));
        return i;
      });
      return;
    }
    setIndex((prev) => (prev === i ? prev : i));
    if (onNearEnd && i >= videoIds.length - 3) onNearEnd();
  }, [videoIds.length, onNearEnd, fs, seriesMode, seriesEps, seriesVideoId]);

  const go = useCallback((delta: number) => {
    const el = boxRef.current;
    if (!el) return;
    const cur = seriesMode ? epIndex : index;
    const len = seriesMode ? Math.max(seriesEps.length, 1) : videoIds.length;
    const next = Math.max(0, Math.min(len - 1, cur + delta));
    el.scrollTo({ top: next * el.clientHeight, behavior: "smooth" });
  }, [index, epIndex, videoIds.length, seriesMode, seriesEps.length]);

  /* 初始定位 */
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = startIndex * (el.clientHeight || 1);
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 拉详情（当前 + 邻接预取） */
  useEffect(() => {
    let alive = true;
    const need = [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean);
    need.forEach((id) => {
      if (details[id]) return;
      api.video(id).then((d) => { if (alive) setDetails((m) => ({ ...m, [id]: d })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, videoIds]);

  /* 吃瓜帖子：直接拿帖子详情（含 video_url） */
  useEffect(() => {
    if (kind !== "post") return;
    let alive = true;
    [videoIds[index], videoIds[index + 1], videoIds[index - 1]].filter(Boolean).forEach((id) => {
      if (posts[id]) return;
      api.post(id).then((p) => { if (alive) setPosts((m) => ({ ...m, [id]: p })); }).catch(() => {});
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, index, videoIds]);

  /* 拉播放地址 + 预取后续几集 / 邻接剧，保证切换更顺 */
  useEffect(() => {
    if (!curId) return;
    let alive = true;
    const targets: { id: number; ep: number; critical?: boolean }[] = [];
    if (seriesMode && seriesEps.length) {
      for (const off of [0, 1, 2, -1]) {
        const ep = seriesEps[epIndex + off];
        if (ep) targets.push({ id: curId, ep: ep.ep_num, critical: off === 0 });
      }
    } else {
      targets.push({ id: curId, ep: curEp, critical: true });
      const nextEp = episodes.find((e) => e.ep_num === curEp + 1);
      if (nextEp) targets.push({ id: curId, ep: nextEp.ep_num });
      const nextEp2 = episodes.find((e) => e.ep_num === curEp + 2);
      if (nextEp2) targets.push({ id: curId, ep: nextEp2.ep_num });
      [videoIds[index + 1], videoIds[index + 2]].filter(Boolean).forEach((id) => {
        const ep = epMap[id] || 1;
        targets.push({ id, ep });
      });
    }
    targets.forEach(({ id, ep, critical }) => {
      const key = `${id}:${ep}`;
      if (playUrls[key]) {
        if (critical && id === curId && ep === curEp) addHistory(id, ep);
        return;
      }
      api.play(id, ep)
        .then((info) => {
          if (!alive) return;
          if (!info?.video_url) {
            if (critical) throw new Error("暂无播放地址");
            return;
          }
          setPlayUrls((m) => (m[key] ? m : { ...m, [key]: info.video_url }));
          if (critical) addHistory(id, ep);
        })
        .catch((e) => {
          if (alive && critical) setErr((e as Error).message || "取播放地址失败");
        });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId, curEp, playTry, seriesMode, epIndex, index, seriesEps.length, episodes.length]);

  /* 切换条目/集数时重置播放与缩放状态。
     邻接槽已经缓冲出画面时不要再盖一层转圈，否则切过去会闪一下。 */
  useLayoutEffect(() => {
    setTime(0); setDuration(0); setBuffered(0); setErr(""); setPaused(false); setDescOpen(false);
    setPortraitFit("contain");
    setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
    const v = videoRef.current?.el();
    setVsize(v && v.videoWidth > 0 && v.videoHeight > 0 ? { w: v.videoWidth, h: v.videoHeight } : { w: 0, h: 0 });
    setWaiting(!(v && v.readyState >= 2));
  }, [playKey]);

  /* 进出全屏时复位双指缩放并校准滚动条位置 */
  useEffect(() => {
    setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
    if (!fs && boxRef.current) {
      const el = boxRef.current;
      const slot = seriesMode ? epIndex : index;
      requestAnimationFrame(() => {
        el.scrollTop = slot * (el.clientHeight || 1);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fs]);

  /* 音量/静音同步 */
  useEffect(() => { videoRef.current?.mute(muted); }, [muted]);
  useEffect(() => { videoRef.current?.volume(volume); }, [volume]);
  /* 倍速同步（长按 2x / 锁定 2x / 基准倍速） */
  useEffect(() => { videoRef.current?.rate(effRate); }, [effRate, playKey]);

  /* 离开播放页时把最后位置落盘并清理计时器 */
  useEffect(() => () => {
    clearTapTimer();
    const s = liveRef.current;
    if (s.id && s.dur) addHistory(s.id, s.ep, s.t, s.dur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 键盘 */
  useEffect(() => {
    if (!active || controlsLocked) return;
    const fn = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (panel) { if (e.key === "Escape") setPanel(null); return; }
      switch (e.key) {
        case "ArrowDown": e.preventDefault(); go(1); break;
        case "ArrowUp": e.preventDefault(); go(-1); break;
        case " ": e.preventDefault(); videoRef.current?.toggle(); break;
        case "ArrowLeft": e.preventDefault(); videoRef.current?.seek(Math.max(0, time - 5), "keyboard_shortcut"); break;
        case "ArrowRight": e.preventDefault(); videoRef.current?.seek(time + 5, "keyboard_shortcut"); break;
        case "f": case "F": toggleFull(); break;
        case "t": case "T": setTheater((v) => !v); break;
        case "m": case "M": setMuted((v) => !v); break;
        case "l": case "L": onLike(); break;
        case "s": case "S": onFav(); break;
        case "c": case "C": setPanel("comments"); break;
        case "e": case "E": setPanel("episodes"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked, panel, time, index]);

  /* 安卓返回键：面板 → 退出全集模式 → 退栈 */
  useEffect(() => {
    if (panel) {
      setBackHandler(() => { setPanel(null); return true; });
      return () => setBackHandler(null);
    }
    if (seriesMode) {
      setBackHandler(() => { exitSeries(); return true; });
      return () => setBackHandler(null);
    }
    setBackHandler(null);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, seriesMode]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFull = () => {
    const el = boxRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  };

  /* —— 双指捏合缩放 & 平移（Pinch-to-Zoom & Pan） —— */
  const cancelSingleGesture = () => {
    clearTapTimer();
    const g = gesture.current;
    if (g?.timer) window.clearTimeout(g.timer);
    gesture.current = null;
    if (holdRef.current) {
      holdRef.current = false;
      setHoldSpeed(false);
    }
    lockArmedRef.current = false;
    setLockArmed(false);
    setScrub(null);
    scrubTarget.current = null;
  };

  const onTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked) return;
    if (e.touches.length === 2) {
      cancelSingleGesture();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist0 = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX0 = (t0.clientX + t1.clientX) / 2;
      const midY0 = (t0.clientY + t1.clientY) / 2;
      pinchRef.current = {
        dist0,
        midX0,
        midY0,
        scale0: zoom.scale,
        x0: zoom.x,
        y0: zoom.y,
      };
    }
  };

  const onTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked) return;
    if (e.touches.length === 2 && pinchRef.current) {
      const p = pinchRef.current;
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const dist = Math.max(12, Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY));
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const nextScale = Math.max(0.85, Math.min(3.5, p.scale0 * (dist / p.dist0)));
      const rawDx = midX - p.midX0;
      const rawDy = midY - p.midY0;
      const dx = rotated ? rawDy : rawDx;
      const dy = rotated ? -rawDx : rawDy;
      const maxX = Math.max(0, (nextScale - 1) * window.innerWidth * 0.55);
      const maxY = Math.max(0, (nextScale - 1) * window.innerHeight * 0.55);
      const nextX = Math.max(-maxX, Math.min(maxX, p.x0 + dx));
      const nextY = Math.max(-maxY, Math.min(maxY, p.y0 + dy));
      setZoom({ scale: nextScale, x: nextX, y: nextY, gesturing: true });
    }
  };

  const onTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isDesktop) return;
    if (pinchRef.current && e.touches.length < 2) {
      pinchRef.current = null;
      setZoom((prev) =>
        prev.scale < 1.08
          ? { scale: 1, x: 0, y: 0, gesturing: false }
          : { ...prev, gesturing: false },
      );
    }
  };

  /* —— 长按 2x（上滑锁定） / 横拖定位 / 单击清屏 / 双击暂停 —— */
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDesktop || controlsLocked || !active || !e.isPrimary || pinchRef.current || gesture.current || e.button !== 0) return;
    const el = e.currentTarget;
    const span = rotated ? (el.clientHeight || window.innerHeight || 1) : (el.clientWidth || 1);
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const g = {
      x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
      t: Date.now(), base: time, width: span,
      playing: videoRef.current?.el()?.paused === false,
      mode: "idle" as "idle" | "hold" | "scrub" | "pan",
      timer: window.setTimeout(() => {
        const cur = gesture.current;
        if (!cur || cur.mode !== "idle" || pinchRef.current) return;
        clearTapTimer();
        cur.mode = "hold";
        holdRef.current = true;
        setHoldSpeed(true);
        setLockArmed(false);
        lockArmedRef.current = false;
        try { navigator.vibrate?.(25); } catch { /* ignore */ }
      }, 380) as unknown as number,
    };
    gesture.current = g;
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pinchRef.current) {
      cancelSingleGesture();
      return;
    }
    const g = gesture.current;
    if (!g || isDesktop || !e.isPrimary) return;
    const rawDx = e.clientX - g.x;
    const rawDy = e.clientY - g.y;
    const dx = rotated ? rawDy : rawDx;
    const dy = rotated ? -rawDx : rawDy;

    /* 长按中：上滑 64px 进入「松开即锁定」 */
    if (g.mode === "hold") {
      const upDist = rotated ? (e.clientX - g.startX) : (g.startY - e.clientY);
      const armed = upDist > 64;
      if (armed !== lockArmedRef.current) {
        lockArmedRef.current = armed;
        setLockArmed(armed);
      }
      return;
    }

    if (g.mode === "idle") {
      if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        clearTapTimer();
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "scrub";
      } else if (Math.abs(dy) > 16) {
        clearTapTimer();
        if (g.timer) window.clearTimeout(g.timer);
        g.mode = "pan";
      }
      return;
    }

    if (g.mode === "scrub") {
      const total = duration || 0;
      if (!total) return;
      const target = Math.max(0, Math.min(total - 0.2, g.base + (dx / g.width) * total));
      scrubTarget.current = target;
      setScrub({ pct: (target / total) * 100, target });
    }
  };

  const onUp = (e?: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (pinchRef.current) return;
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (g.timer) window.clearTimeout(g.timer);

    if (g.mode === "hold") {
      holdRef.current = false;
      setHoldSpeed(false);
      if (!cancelled && lockArmedRef.current) {
        setSpeedLock(true);
        toast("已锁定 2.0x 倍速 · 点顶部标签解除", "info");
      }
      lockArmedRef.current = false;
      setLockArmed(false);
      return;
    }
    if (g.mode === "scrub") {
      const target = scrubTarget.current;
      setScrub(null);
      scrubTarget.current = null;
      if (!cancelled && target != null) {
        setErr("");
        setTime(target);
        videoRef.current?.seek(target, "mobile_gesture");
      }
      if (g.playing && active) videoRef.current?.play();
      return;
    }

    if (cancelled || g.mode !== "idle") return;
    const moveDist = e ? Math.hypot(e.clientX - g.x, e.clientY - g.y) : 0;
    if (Date.now() - g.t < 260 && moveDist < 16) {
      const now = Date.now();
      const tapX = e?.clientX ?? g.x;
      const tapY = e?.clientY ?? g.y;
      if (now - lastTapRef.current.time < 280) {
        // 红果式：双击点赞（未赞时点赞并飘心；已赞则切暂停）
        clearTapTimer();
        lastTapRef.current.time = 0;
        if (!isLiked(curId)) {
          const box = boxRef.current?.getBoundingClientRect();
          onLike({
            x: box ? tapX - box.left : tapX,
            y: box ? tapY - box.top : tapY,
          });
        } else {
          videoRef.current?.toggle();
        }
      } else {
        // 单击：显示 / 隐藏控件（清屏）
        lastTapRef.current.time = now;
        clearTapTimer();
        lastTapRef.current.timer = window.setTimeout(() => {
          lastTapRef.current.timer = null;
          setClean((c) => !c);
        }, 250) as unknown as number;
      }
    }
  };

  useEffect(() => {
    if (!active || controlsLocked) onUp(undefined, true);
    // Cancel pending gestures when the page is hidden or controls are locked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, controlsLocked]);

  useEffect(() => () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    gesture.current = null;
  }, [playKey]);

  const lockControls = () => { setPanel(null); setControlsLocked(true); };

  /* 长按倍速 / 双指缩放 / 全屏期间禁止外层列表原生滚动 */
  useEffect(() => {
    if (isDesktop) return undefined;
    const el = boxRef.current;
    if (!el) return undefined;
    const fn = (e: TouchEvent) => {
      if (holdRef.current || pinchRef.current || fs || e.touches.length >= 2) {
        e.preventDefault();
      }
    };
    el.addEventListener("touchmove", fn, { passive: false });
    return () => el.removeEventListener("touchmove", fn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktop, videoIds.length, fs]);

  /* —— 进度条拖动（直接用当前触发元素的 BoundingRect，旋转舞台下按 Y 轴换算） —— */
  const barPctAt = (barEl: HTMLElement | null, clientX: number, clientY: number) => {
    const r = barEl?.getBoundingClientRect();
    if (!r) return null;
    const span = rotated ? r.height : r.width;
    if (!span) return null;
    const raw = rotated ? (clientY - r.top) / span : (clientX - r.left) / span;
    return Math.max(0, Math.min(1, raw));
  };
  const barSeekTo = (barEl: HTMLElement | null, clientX: number, clientY: number) => {
    const pct = barPctAt(barEl, clientX, clientY);
    if (pct == null) return null;
    setBarPct(pct);
    return pct;
  };
  const onBarDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    videoRef.current?.trace("seek.input.down", { input: "mobile_bar" });
    barScrub.current = true;
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    barSeekTo(el, e.clientX, e.clientY);
  };
  const onBarMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    e.stopPropagation();
    videoRef.current?.trace("seek.input.move", { input: "mobile_bar" });
    barSeekTo(e.currentTarget as HTMLElement, e.clientX, e.clientY);
  };
  const onBarUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barScrub.current) return;
    barScrub.current = false;
    e.stopPropagation();
    const pct = barPctAt(e.currentTarget as HTMLElement, e.clientX, e.clientY) ?? barPct;
    setBarPct(null);
    if (pct != null && duration > 0) {
      const target = Math.max(0, Math.min(duration - 0.15, pct * duration));
      setErr("");
      setTime(target);
      videoRef.current?.trace("seek.input.up", { input: "mobile_bar", target });
      videoRef.current?.seek(target, "mobile_bar");
    }
  };

  const togglePip = async () => {
    try {
      const v = videoRef.current?.el();
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (v && document.pictureInPictureEnabled) await v.requestPictureInPicture();
      else toast("当前环境不支持画中画", "info");
    } catch { toast("画中画开启失败", "info"); }
  };

  const syncAccount = () => !!user && !user.guest;

  const spawnHeart = (x: number, y: number) => {
    const id = ++heartIdRef.current;
    setFloatHearts((list) => [...list.slice(-6), { id, x, y }]);
    window.setTimeout(() => setFloatHearts((list) => list.filter((h) => h.id !== id)), 900);
  };

  const onLike = (at?: { x: number; y: number }) => {
    if (!curId) return;
    const wasLiked = isLiked(curId);
    const on = toggleLikeLocal(curId);
    setHeartBurst((n) => n + 1);
    if (on && !wasLiked) {
      const box = boxRef.current?.getBoundingClientRect();
      spawnHeart(at?.x ?? (box ? box.width * 0.5 : window.innerWidth * 0.5), at?.y ?? (box ? box.height * 0.42 : window.innerHeight * 0.42));
    }
    toast(on ? "已喜欢" : "已取消喜欢", on ? "heart" : "info");
    if (syncAccount()) { if (kind === "post") api.postLike(curId, on).catch(() => {}); else api.like(curId, curEp, on).catch(() => {}); }
  };

  const onFav = () => {
    if (!curId) return;
    const on = toggleFavLocal(curId);
    toast(on ? "已收藏" : "已取消收藏", on ? "star" : "info");
    if (syncAccount()) { if (kind === "post") api.postCollect(curId, on).catch(() => {}); else api.collect(curId, on).catch(() => {}); }
  };

  const onFollow = () => {
    const uid = meta.authorId > 0 ? meta.authorId : undefined;
    if (!uid) return;
    const on = toggleFollowLocal(uid);
    toast(on ? `已关注 ${detail?.author?.name}` : "已取消关注", on ? "ok" : "info");
    if (syncAccount()) api.follow(uid, on).catch(() => {});
  };

  const scrollToSlot = (slot: number) => {
    const el = boxRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = slot * (el.clientHeight || 1);
    });
  };

  const enterSeries = (ep?: number) => {
    if (kind !== "video" || !curId) return;
    const eps = details[curId]?.episodes || [];
    if (!eps.length) {
      setPanel("episodes");
      return;
    }
    const target = ep || curEp || eps[0].ep_num;
    const ei = Math.max(0, eps.findIndex((e) => e.ep_num === target));
    setSeriesVideoId(curId);
    setSeriesMode(true);
    setSeriesOpen(true);
    setEpIndex(ei);
    setEpMap((m) => ({ ...m, [curId]: target }));
    setPanel(null);
    setClean(false);
    scrollToSlot(ei);
  };

  const exitSeries = () => {
    const id = seriesVideoId;
    setSeriesMode(false);
    setSeriesVideoId(null);
    setSeriesOpen(false);
    if (id != null) {
      const vi = videoIds.indexOf(id);
      if (vi >= 0) {
        setIndex(vi);
        scrollToSlot(vi);
      }
    }
  };

  /* 卸载时清掉全集底栏状态 */
  useEffect(() => () => { setSeriesOpen(false); }, [setSeriesOpen]);

  const pickEp = (ep: number) => {
    setEpMap((m) => ({ ...m, [curId]: ep }));
    setPanel(null);
    if (seriesMode) {
      const ei = Math.max(0, episodes.findIndex((e) => e.ep_num === ep));
      setEpIndex(ei);
      scrollToSlot(ei);
      return;
    }
    /* 从选集面板点选 → 进入全集模式，便于继续上下滑连播 */
    enterSeries(ep);
  };

  const playNextEpisode = () => {
    if (seriesMode) {
      if (epIndex < seriesEps.length - 1) go(1);
      return;
    }
    const next = episodes.find((e) => e.ep_num === curEp + 1);
    if (next) {
      /* 首页信息流里播完自动进全集模式并切下一集 */
      enterSeries(next.ep_num);
      return;
    }
    go(1);
  };

  const likeCount = useMemo(() => {
    const base = meta.like;
    return base + (isLiked(curId) ? 1 : 0);
  }, [meta.like, curId, isLiked]);

  if (!videoIds.length) {
    return <div className="absolute inset-0 bg-black flex items-center justify-center"><div className="w-9 h-9 spinner" /></div>;
  }

  const effectiveFit: "contain" | "cover" = isDesktop
    ? "contain"
    : isLandscapeVideo
      ? (fs || vpLandscape ? "contain" : portraitFit)
      : (vpLandscape ? "contain" : "cover");

  /* 信息流槽位：普通模式按剧目；全集模式按集数上下滑 */
  const slots: { key: string; vid: number; ep?: number; i: number }[] = seriesMode && seriesEps.length
    ? seriesEps.map((ep, i) => ({ key: `ep-${seriesVideoId}-${ep.ep_num}`, vid: seriesVideoId!, ep: ep.ep_num, i }))
    : videoIds.map((vid, i) => ({ key: `vid-${vid}`, vid, i }));
  const activeSlot = seriesMode ? epIndex : index;
  const slotCount = slots.length;
  const canGoPrev = activeSlot > 0;
  const canGoNext = activeSlot < slotCount - 1;
  const counterLabel = seriesMode
    ? `${epIndex + 1} / ${Math.max(seriesEps.length, 1)}`
    : `${index + 1} / ${videoIds.length}`;

  const handleBack = () => {
    if (seriesMode) { exitSeries(); return; }
    onBack?.();
  };

  return (
    <div
      className={`hg-player-ui absolute inset-0 overflow-hidden bg-black player-root ${controlsLocked ? "is-locked" : ""} ${isDesktop ? "player-surface" : ""} ${theater ? "is-theater" : ""} ${isDesktop && idle ? "is-idle" : ""}`}
      onPointerMove={() => { if (isDesktop) wake(); }}>
      <div className="absolute inset-0" inert={controlsLocked}>
      {/* 氛围背景（全屏时隐藏，避免透出封面底图） */}
      {!fs && (
        <div className="absolute inset-0 scale-110 blur-3xl opacity-25 pointer-events-none">
          {posterUrl && <img src={posterUrl} alt="" className="w-full h-full object-cover" />}
        </div>
      )}

      <div ref={boxRef} onScroll={onScroll}
        className={`absolute inset-y-0 left-0 no-bar ${fs ? "overflow-hidden" : "overflow-y-scroll snap-y snap-mandatory overscroll-y-contain"}`}
        style={{ right: isDesktop && panel ? 372 : 0, transition: "right .3s cubic-bezier(.2,0,0,1)" }}>
        {slots.map(({ key, vid, ep, i }) => {
          const isActive = i === activeSlot;
          const near = Math.abs(i - activeSlot) <= 1;
          const slotEp = ep ?? (seriesMode ? undefined : (epMap[vid] || 1));
          const slotUrl = slotEp != null ? (playUrls[`${vid}:${slotEp}`] || "") : (isActive ? playUrl : "");
          const slotPoster = cover(
            cards[vid]?.cover || posts[vid]?.cover || details[vid]?.cover || (isActive ? meta.cover : "") || "",
            900,
          );
          return (
            <section
              key={key}
              style={!isActive && fs ? { display: "none" } : undefined}
              className={`relative w-full h-full snap-start snap-always bg-black ${fs && isActive ? "" : "overflow-hidden"}`}>
              {near && slotUrl ? (
                <div className={isActive ? (rotated ? "fs-landscape" : (!isDesktop && fs ? "fs-immersive" : "absolute inset-0")) : "absolute inset-0"}>
                  <div
                    className="absolute inset-0 overflow-hidden"
                    style={{ touchAction: isActive && (fs || zoom.scale > 1.05) ? "none" : "pan-y" }}
                    onTouchStart={isActive ? onTouchStart : undefined}
                    onTouchMove={isActive ? onTouchMove : undefined}
                    onTouchEnd={isActive ? onTouchEnd : undefined}
                    onTouchCancel={isActive ? onTouchEnd : undefined}
                    onPointerDown={isActive ? onDown : undefined}
                    onPointerMove={isActive ? onMove : undefined}
                    onPointerUp={isActive ? ((e) => onUp(e, false)) : undefined}
                    onPointerCancel={isActive ? ((e) => onUp(e, true)) : undefined}
                    onLostPointerCapture={isActive ? ((e) => onUp(e, true)) : undefined}>
                    <VideoSurface
                      ref={isActive ? bindVideo : undefined}
                      src={slotUrl}
                      poster={fs && isActive ? undefined : slotPoster}
                      autoPlay={isActive}
                      active={active && near}
                      warm={!isActive}
                      diagnosticContext={{ active, view: mode, kind, video_id: vid, episode: slotEp, series_mode: seriesMode, warm: !isActive }}
                      muted={muted || !isActive}
                      volume={isActive ? volume : 0}
                      rate={isActive ? effRate : 1}
                      fit={effectiveFit}
                      scale={isActive ? zoom.scale : 1}
                      panX={isActive ? zoom.x : 0}
                      panY={isActive ? zoom.y : 0}
                      isGesturing={isActive && zoom.gesturing}
                      onClick={isActive ? (() => { if (isDesktop) videoRef.current?.toggle(); }) : undefined}
                      onTime={isActive ? onTimeTick : undefined}
                      onDuration={isActive ? onDurationTick : undefined}
                      onSize={isActive ? ((w, h) => setVsize({ w, h })) : undefined}
                      onPlaying={isActive ? (() => { setPaused(false); setWaiting(false); setErr(""); }) : undefined}
                      onPause={isActive ? (() => setPaused(true)) : undefined}
                      onWaiting={isActive ? (() => setWaiting(true)) : undefined}
                      onEnded={isActive ? playNextEpisode : undefined}
                      onError={isActive ? ((m) => setErr(m)) : undefined}
                    />
                  </div>

                  {/* 横拖定位浮层 */}
                  {!isDesktop && scrub && (
                    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none" style={{ background: "rgba(0,0,0,.25)" }}>
                      <span className="text-[26px] font-bold hg-ink tabular-nums hg-ov-shadow">{fmtTime(scrub.target)}</span>
                      <span className="text-[11px] hg-ink-4 mt-1 tabular-nums">/ {fmtTime(duration)}</span>
                      <div className="mt-4 w-[62%] h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,.25)" }}>
                        <div className="h-full bg-white" style={{ width: `${scrub.pct}%` }} />
                      </div>
                    </div>
                  )}

                  {/* 暂停 / 缓冲 / 报错恢复（只盖当前槽，避免邻接预热画面一起闪） */}
                  {isActive && paused && !err && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                      <span className="hg-pause-orb">
                        <IPlayF size={28} className="hg-ink ml-0.5" />
                      </span>
                    </div>
                  )}
                  {isActive && waiting && !err && !paused && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none"><div className="w-9 h-9 spinner" /></div>
                  )}
                  {isActive && err && (
                    <div className="absolute inset-0 z-30 flex items-center justify-center">
                      <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[13px] hg-ink-2" style={{ background: "rgba(0,0,0,.74)" }}>
                        <span>视频暂时无法加载</span>
                        <span className="text-[10.5px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
                        <button className="px-4 py-1.5 rounded-full hg-chip-strong hg-link text-[12.5px] font-semibold pressable"
                          onClick={() => { setErr(""); setWaiting(true); videoRef.current?.reload(); }}>
                          重新加载
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 移动端：倍速状态 / 锁定提示 */}
                  {!isDesktop && (!clean || holdSpeed) && (holdSpeed || speedLock || rate !== 1) && (
                    <button
                      onClick={() => {
                        if (speedLock) { setSpeedLock(false); toast("已解除倍速锁定", "info"); }
                        else if (rate !== 1 && !holdSpeed) setRate(1);
                      }}
                      className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-3.5 h-8 rounded-full backdrop-blur-md text-[12px] font-bold elev-2 pressable ${speedLock ? "bg-primary text-on-primary" : "hg-chip hg-gold"}`}
                      style={{ top: rotated || vpLandscape ? 14 : "calc(var(--sat, 0px) + 54px)" }}>
                      <IBoltF size={13} />
                      {effRate}x {speedLock ? "已锁定 · 点按解除" : holdSpeed ? "倍速中 · 松开恢复" : "倍速"}
                    </button>
                  )}
                  {!isDesktop && holdSpeed && (
                    <div
                      className={`absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 h-10 rounded-xl backdrop-blur-md elev-2 transition-all duration-200 ${lockArmed ? "bg-primary text-on-primary scale-110" : "hg-chip-strong hg-ink-2"}`}
                      style={{ top: "38%" }}>
                      <ILockF size={16} />
                      <span className="text-[12.5px] font-bold">{lockArmed ? "松开锁定 2.0x" : "上滑到此锁定倍速"}</span>
                    </div>
                  )}

                  {/* 移动端：沉浸全屏控制栏（清屏 clean 模式下隐藏，单击屏幕可呼出/隐藏） */}
                  {!isDesktop && fs && !clean && !controlsLocked && (
                    <>
                      <div className="absolute right-4 z-40 flex items-center gap-2"
                        style={{ top: rotated || vpLandscape ? 14 : "calc(var(--sat, 0px) + 8px)" }}>
                        <button onClick={lockControls} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false}
                          className="hg-chip-strong w-9 h-9 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
                          <ILockF size={17} />
                        </button>
                        <button onClick={exitFs} aria-label="退出全屏"
                          className="hg-chip-strong w-9 h-9 rounded-full backdrop-blur-md flex items-center justify-center pressable elev-1">
                          <ICompress size={18} />
                        </button>
                      </div>
                      {zoom.scale > 1.05 && (
                        <button
                          onClick={() => setZoom({ scale: 1, x: 0, y: 0, gesturing: false })}
                          className="hg-chip-strong absolute left-4 z-40 px-3 h-8 rounded-full backdrop-blur-md text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1"
                          style={{ top: rotated || vpLandscape ? 14 : "calc(var(--sat, 0px) + 8px)" }}>
                          还原画面 ({zoom.scale.toFixed(1)}x)
                        </button>
                      )}
                      <div className="absolute inset-x-0 z-30 px-4" style={{ bottom: rotated || vpLandscape ? 46 : "calc(var(--sab, 0px) + 52px)" }}>
                        <div className={`hg-seek ${barPct !== null ? "is-scrubbing" : ""}`}
                          onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                          <div className="hg-seek-track">
                            <div className="hg-seek-played" style={{ width: `${barProgress * 100}%` }}>
                              <span className="hg-seek-thumb" />
                            </div>
                          </div>
                          {barPct !== null && (
                            <div className="hg-seek-tip">
                              {fmtTime(barPct * (duration || 0))} / {fmtTime(duration)}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="absolute inset-x-0 z-40 flex items-center gap-3 px-4"
                        style={{ bottom: rotated || vpLandscape ? 10 : "calc(var(--sab, 0px) + 10px)" }}>
                        <button onClick={() => videoRef.current?.toggle()}
                          className="hg-chip shrink-0 w-9 h-9 rounded-full flex items-center justify-center pressable">
                          {paused ? <IPlayF size={18} /> : <IPauseF size={17} />}
                        </button>
                        <span className="shrink-0 text-[11.5px] font-semibold hg-ink-2 tabular-nums">{fmtTime(time)}</span>
                        <button
                          onClick={() => {
                            if (speedLock) { setSpeedLock(false); return; }
                            const seq = [1, 1.25, 1.5, 2];
                            const idx = seq.indexOf(rate);
                            setRate(seq[(idx + 1) % seq.length]);
                          }}
                          className={`ml-auto shrink-0 flex items-center gap-1 px-2.5 h-8 rounded-full text-[12px] font-bold pressable ${effRate !== 1 ? "bg-primary text-on-primary" : "hg-chip hg-ink-2"}`}>
                          <IBoltF size={12} />{effRate}x
                        </button>
                        <span className="shrink-0 text-[11.5px] hg-ink-4 tabular-nums">{fmtTime(duration)}</span>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="absolute inset-0">
                  <Img src={cards[vid]?.cover || posts[vid]?.cover || details[vid]?.cover || (isActive ? detail?.cover : "") || ""} eager={Math.abs(i - activeSlot) <= 1} />
                  <div className="absolute inset-0" style={{ background: "rgba(0,0,0,.25)" }} />
                </div>
              )}

              {/* 取不到播放地址时播放器不会创建，错误提示要放在播放器外面，否则只会停在封面 */}
              {isActive && kind === "video" && !playUrl && !!err && (
                <div className="absolute inset-0 z-30 flex items-center justify-center">
                  <div className="rounded-xl p-5 flex flex-col items-center gap-3 text-[13px] hg-ink-2" style={{ background: "rgba(0,0,0,.74)" }}>
                    <span>视频暂时无法加载</span>
                    <span className="text-[10.5px] hg-ink-4 max-w-[240px] text-center break-all">{err}</span>
                    <button className="px-4 py-1.5 rounded-full hg-chip-strong hg-link text-[12.5px] font-semibold pressable"
                      onClick={() => { setErr(""); setWaiting(true); setPlayTry((n) => n + 1); }}>
                      重新加载
                    </button>
                  </div>
                </div>
              )}

              {/* 图文帖：没有视频就给个正文入口 */}
              {isActive && kind === "post" && !!post && !post.video_url && (
                <div className="absolute inset-0 z-10 flex items-center justify-center">
                  <button type="button" onClick={() => setPanel("article")}
                    className="flex items-center gap-2 h-11 px-5 rounded-full text-[13.5px] font-semibold pressable elev-3"
                    style={{ background: "rgba(255,255,255,.94)", color: "#0b0e15" }}>
                    <IFileText size={17} />查看图文详情
                  </button>
                </div>
              )}

              {/* 渐变压暗，保证文字可读（清屏模式下不加压暗遮罩，只显示纯视频内容） */}
              {!fs && !clean && (
                <div className="absolute inset-0 pointer-events-none"
                  style={{ background: "linear-gradient(0deg, rgba(8,11,15,.86) 0, rgba(11,14,20,.18) 26%, transparent 48%)" }} />
              )}

              {/* 竖屏下观看横屏视频：快捷「放大铺满 / 完整显示 / 全屏横屏」与双指缩放复位胶囊 */}
              {isActive && !fs && !clean && !isDesktop && (isLandscapeVideo || zoom.scale > 1.05) && (
                <div
                  className="absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-2"
                  style={{ top: "64%" }}>
                  {isLandscapeVideo && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          if (zoom.scale > 1.05) {
                            setZoom({ scale: 1, x: 0, y: 0, gesturing: false });
                            setPortraitFit("contain");
                          } else {
                            setPortraitFit((f) => (f === "contain" ? "cover" : "contain"));
                          }
                        }}
                        className="hg-chip-strong backdrop-blur-md px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1.5 pressable elev-1">
                        {zoom.scale > 1.05
                          ? `还原缩放 (${zoom.scale.toFixed(1)}x)`
                          : portraitFit === "contain"
                            ? "放大铺满"
                            : "完整适应"}
                      </button>
                      <button
                        type="button"
                        onClick={enterFs}
                        className="hg-chip-strong backdrop-blur-md px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1">
                        <IExpand size={12} />横屏全屏
                      </button>
                    </>
                  )}
                  {!isLandscapeVideo && zoom.scale > 1.05 && (
                    <button
                      type="button"
                      onClick={() => setZoom({ scale: 1, x: 0, y: 0, gesturing: false })}
                      className="hg-chip-strong backdrop-blur-md px-3 h-7 rounded-full text-[11.5px] font-semibold flex items-center gap-1 pressable elev-1">
                      还原画面 ({zoom.scale.toFixed(1)}x)
                    </button>
                  )}
                </div>
              )}

              {/* 顶部：上下文页 / 全集模式返回 */}
              {!fs && !clean && (mode === "context" || seriesMode) ? (
                isDesktop ? (
                  <div className="desktop-context-header">
                    <button onClick={handleBack} aria-label="返回"><IBack size={17} /></button>
                    <span>{seriesMode ? (meta.title || title || "全集播放") : title}</span>
                    <small>{counterLabel}</small>
                  </div>
                ) : (
                  <div className="absolute inset-x-0 z-20 flex items-center gap-2 px-2.5" style={{ top: "calc(var(--sat, 0px) + 8px)", paddingRight: 148 }}>
                    <button onClick={handleBack} aria-label="返回" className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><IBack size={20} /></button>
                    <span className="text-[14.5px] font-semibold hg-ink hg-ov-shadow truncate">{seriesMode ? (meta.title || "全集播放") : title}</span>
                    <span className="ml-auto px-2 py-0.5 rounded-full hg-chip text-[11px] font-semibold" style={{ color: "rgba(255,255,255,.9)" }}>{counterLabel}</span>
                  </div>
                )
              ) : null}

              {/* 右侧操作栏（移动端 · 红果式）：点赞 / 评论 / 收藏 / 选集 / 分享 */}
              {!fs && !clean && !isDesktop && (
                <div className="hg-social absolute right-2.5 z-20"
                  style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset + 108}px)` }}>
                  {kind === "video" && (
                    <button onClick={() => onLike()} className={`hg-social-btn pressable ${isLiked(curId) ? "is-on" : ""}`} aria-pressed={isLiked(curId)} aria-label="点赞">
                      <span key={heartBurst} className={`hg-social-icon ${heartBurst ? "a-pop" : ""}`}>
                        {isLiked(curId) ? <IHeartF size={24} className="hg-accent" /> : <IHeart size={24} className="hg-ink" />}
                      </span>
                      <span className="hg-social-count">{fmt(likeCount)}</span>
                    </button>
                  )}
                  <button onClick={() => setPanel("comments")} className="hg-social-btn pressable" aria-label="评论">
                    <span className="hg-social-icon"><ICommentF size={22} className="hg-ink" /></span>
                    <span className="hg-social-count">{meta.comment ? fmt(meta.comment) : "评论"}</span>
                  </button>
                  <button onClick={onFav} className={`hg-social-btn pressable ${isFav(curId) ? "is-on" : ""}`} aria-pressed={isFav(curId)} aria-label="收藏">
                    <span className="hg-social-icon">
                      {isFav(curId) ? <IStarF size={22} className="hg-gold" /> : <IStar size={22} className="hg-ink" />}
                    </span>
                    <span className="hg-social-count">{meta.collect ? fmt(meta.collect) : "收藏"}</span>
                  </button>
                  {kind === "video" && (
                    <button onClick={() => setPanel("episodes")} className="hg-social-btn pressable" aria-label="选集">
                      <span className="hg-social-icon"><IList size={22} className="hg-ink" /></span>
                      <span className="hg-social-count">选集</span>
                    </button>
                  )}
                  <button onClick={shareLink} className="hg-social-btn pressable" aria-label="分享">
                    <span className="hg-social-icon"><ILink size={21} className="hg-ink" /></span>
                    <span className="hg-social-count">分享</span>
                  </button>
                </div>
              )}

              {/* 右侧操作栏（桌面 · 红果式圆形按钮） */}
              {!fs && isDesktop && (
              <div className="absolute z-20 flex flex-col items-center desktop-social">
                <div className="desktop-browse-inline">
                  <button onClick={() => go(-1)} disabled={!canGoPrev} aria-label="上一个" title="上一个 ↑">
                    <IChevronUp size={19} strokeWidth={1.8} />
                  </button>
                  <button onClick={() => go(1)} disabled={!canGoNext} aria-label="下一个" title="下一个 ↓">
                    <IChevronDown size={19} strokeWidth={1.8} />
                  </button>
                  <small>{String(activeSlot + 1).padStart(2, "0")} / {String(slotCount).padStart(2, "0")}</small>
                </div>

                {kind === "video" && (
                  <>
                    <button onClick={() => onLike()} className="pressable" aria-pressed={isLiked(curId)}>
                      <span key={heartBurst} className={`hg-social-icon ${heartBurst ? "a-pop" : ""}`}>
                        {isLiked(curId) ? <IHeartF size={22} className="hg-accent" /> : <IHeart size={22} className="text-white" />}
                      </span>
                      <span>{fmt(likeCount)}</span>
                    </button>

                    <button onClick={() => setPanel("comments")} className="pressable">
                      <span className="hg-social-icon"><ICommentF size={20} className="text-white" /></span>
                      <span>{fmt(meta.comment)}</span>
                    </button>

                    <button onClick={onFav} className="pressable" aria-pressed={isFav(curId)}>
                      <span className="hg-social-icon">
                        {isFav(curId) ? <IStarF size={20} className="hg-gold" /> : <IStar size={20} className="text-white" />}
                      </span>
                      <span>{fmt(meta.collect)}</span>
                    </button>

                    <button onClick={() => setPanel("episodes")} className="pressable">
                      <span className="hg-social-icon"><IList size={20} className="text-white" /></span>
                      <span>选集</span>
                    </button>
                  </>
                )}

                <button onClick={shareLink} className="pressable">
                  <span className="hg-social-icon"><ILink size={19} className="text-white" /></span>
                  <span>分享</span>
                </button>
              </div>
              )}

              {/* 桌面：左下信息（红果式作者行 + 选集胶囊） */}
              {!fs && isDesktop && (
              <div className="desktop-video-meta">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Avatar size={32} name={meta.author} hue={350} />
                  <span className="text-[14.5px] font-bold text-white tsh truncate">@{meta.author}</span>
                  {meta.authorId > 0 && (
                    <button type="button" onClick={onFollow}
                      className={`hg-follow-btn pressable ${store.follows.includes(meta.authorId) ? "is-on" : ""}`}
                      style={{ height: 24, fontSize: 11 }}>
                      {store.follows.includes(meta.authorId) ? "已关注" : "+ 关注"}
                    </button>
                  )}
                  {episodes.length > 0 && (
                    <button type="button" onClick={() => (seriesMode ? setPanel("episodes") : enterSeries())} className="hg-ep-cta pressable" style={{ height: 24, fontSize: 11 }}>
                      {seriesMode ? `第 ${curEp}/${episodes.length} 集` : `查看全集 · ${episodes.length}集`} <IChevR size={11} />
                    </button>
                  )}
                  {!!meta.score && (
                    <span className="shrink-0 text-[11px] font-bold" style={{ color: "#ffb3c0" }}>{meta.score.toFixed(1)} 分</span>
                  )}
                </div>

                <p className="text-[15px] font-bold leading-snug text-white tsh clamp-2">{meta.title}</p>

                <button onClick={() => setDescOpen((v) => !v)} className="mt-1.5 text-left w-full pressable group">
                  <p className={`text-[12px] leading-relaxed hg-ink-3 ${descOpen ? "" : "clamp-1"}`}>
                    {meta.desc || "暂无简介"}
                  </p>
                  <span className="text-[11px] font-semibold" style={{ color: "#ff8fa3" }}>{descOpen ? "收起" : "展开简介"}</span>
                </button>
              </div>
              )}

              {/* 移动端：红果式底部信息（作者 / 标题 / 选集 CTA / 进度条） */}
              {!fs && !clean && !isDesktop && (
                <div className="hg-meta-panel absolute inset-x-0 z-20" style={{ bottom: `calc(var(--sab, 0px) + ${bottomInset}px)`, paddingRight: 64 }}>
                  <div className="hg-meta-veil" />
                  <div className="hg-author-row">
                    <Avatar size={34} name={meta.author} hue={350} ring={meta.authorId > 0 && store.follows.includes(meta.authorId)} />
                    <button type="button" onClick={() => setPanel("detail")} className="min-w-0 flex-1 text-left pressable">
                      <div className="hg-author-name truncate">@{meta.author}</div>
                    </button>
                    {meta.authorId > 0 && (
                      <button type="button" onClick={onFollow}
                        className={`hg-follow-btn pressable ${store.follows.includes(meta.authorId) ? "is-on" : ""}`}>
                        {store.follows.includes(meta.authorId) ? "已关注" : "+ 关注"}
                      </button>
                    )}
                  </div>
                  <p className="hg-title-line clamp-2">{meta.title || "加载中…"}</p>
                  <div className="hg-ep-row">
                    {kind === "video" && (
                      <>
                        <button type="button" onClick={() => setPanel(seriesMode ? "episodes" : "detail")} className="hg-ep-pill pressable">
                          第 {curEp}{episodes.length ? ` / ${episodes.length}` : ""} 集
                        </button>
                        <button
                          type="button"
                          onClick={() => (seriesMode ? setPanel("episodes") : enterSeries())}
                          className="hg-ep-cta pressable">
                          <IList size={12} />
                          {seriesMode
                            ? "选集"
                            : (episodes.length ? `查看全集 · ${episodes.length}集` : "选集")}
                          <IChevR size={11} />
                        </button>
                      </>
                    )}
                    {kind === "post" && (
                      <button type="button" onClick={() => setPanel("detail")} className="hg-ep-pill pressable">
                        详情<IChevR size={11} />
                      </button>
                    )}
                    {!!meta.score && (
                      <span className="hg-ep-pill" style={{ background: "rgba(255,77,106,.22)", color: "#ffb3c0" }}>
                        {meta.score.toFixed(1)} 分
                      </span>
                    )}
                  </div>
                  {isActive && hasVideo && (
                    <div className={`hg-seek ${barPct !== null ? "is-scrubbing" : ""}`}
                      onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
                      <div className="hg-seek-track">
                        <div className="hg-seek-played" style={{ width: `${barProgress * 100}%`, transition: barPct !== null ? "none" : "width .25s linear" }}>
                          <span className="hg-seek-thumb" />
                        </div>
                      </div>
                      {barPct !== null && (
                        <div className="hg-seek-tip">
                          {fmtTime(barPct * (duration || 0))} / {fmtTime(duration)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 双击点赞飘心 */}
              {isActive && floatHearts.map((h) => (
                <span key={h.id} className="hg-heart-burst" style={{ left: h.x, top: h.y }}>
                  <IHeartF size={72} />
                </span>
              ))}
            </section>
          );
        })}
      </div>

      {/* 桌面控制条 */}
      {isDesktop && (
        <PlayerControls
          paused={paused} time={time} duration={duration} buffered={buffered} rate={rate}
          muted={muted} volume={volume} theater={theater} fullscreen={fullscreen}
          visible={active && !idle}
          seekEnabled={active && !controlsLocked}
          seekKey={playKey}
          nextDisabled={seriesMode ? epIndex >= seriesEps.length - 1 : (!episodes.some((e) => e.ep_num === curEp + 1) && index >= videoIds.length - 1)}
          nextTitle={seriesMode || episodes.some((e) => e.ep_num === curEp + 1) ? "下一集 ↓" : "下一部 ↓"}
          onToggle={() => videoRef.current?.toggle()}
          onSeek={(t, source) => { videoRef.current?.seek(t, source); setTime(t); }}
          onSeekInteraction={(phase, input, target, pointerTarget) => videoRef.current?.trace(`seek.input.${phase}`, { input, target, pointer_target: pointerTarget })}
          onRate={(r) => { setRate(r); videoRef.current?.rate(r); }}
          onMute={() => setMuted((m) => !m)}
          onVolume={(v) => setVolume(v)}
          onPip={togglePip}
          onLock={lockControls}
          onTheater={() => setTheater((v) => !v)}
          onFullscreen={toggleFull}
          onNext={playNextEpisode}
        />
      )}

      {/* 选集 / 评论：桌面停靠在右侧（画面让位），移动端底部弹层 */}
      {isDesktop ? (
        <div className={`desktop-dock-panel ${panel ? "is-open" : ""}`}>
          <div className="desktop-dock-inner">
            {panel === "episodes" ? (
              <EpisodesPanel videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
            ) : panel === "comments" ? (
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            ) : null}
          </div>
        </div>
      ) : (
        <>
          {/* 评论：移动端底部弹层（右侧操作栏「评论」入口） */}
          <Sheet open={panel === "comments"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72vh" }}>
              <CommentsPanel videoId={curId} ep={curEp} total={meta.comment} kind={kind} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          {/* 吃瓜图文正文 */}
          <Sheet open={panel === "article"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "78vh" }}>
              <ArticlePanel title={meta.title} html={articleHtml} cover={meta.cover} hot={post?.hot} onClose={() => setPanel(null)} />
            </div>
          </Sheet>

          <Sheet open={panel === "detail" || panel === "episodes"} onClose={() => setPanel(null)}>
            <div className="flex flex-col" style={{ height: "72vh" }}>
              {/* 双栏抽屉：详情 / 选集 */}
              <div className="shrink-0 flex items-center gap-2 px-4 pb-2">
                <div className="flex flex-1 bg-s3 rounded-(--r-ctl) p-1">
                  {([["detail", "详情"], ["episodes", "选集"]] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setPanel(k)}
                      className={`flex-1 h-8 rounded-(--r-ctl) text-[12px] font-semibold pressable ${panel === k ? "text-on-sec" : "text-mut"}`}
                      style={panel === k ? { background: "var(--p-sec)", color: "var(--p-primary)" } : undefined}>{l}</button>
                  ))}
                </div>
                <button onClick={() => setPanel(null)} aria-label="关闭"
                  className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-mut pressable">
                  <IClose size={14} />
                </button>
              </div>

              <div className="flex-1 min-h-0">
                {panel === "episodes" ? (
                  <EpisodesPanel bare videoId={curId} episodes={episodes} current={curEp} onPick={pickEp} onClose={() => setPanel(null)} />
                ) : (
                  <div className="h-full scroll-y px-4 pb-5">
                    {/* 封面 / 标题 / 评分 / 数据 */}
                    <div className="flex gap-3">
                      <div className="relative w-[84px] shrink-0 rounded-(--r-sm) overflow-hidden bg-s3" style={{ aspectRatio: "3 / 4" }}>
                        <Img src={meta.cover} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13.5px] font-bold text-on leading-snug clamp-2">{meta.title}</div>
                        <div className="flex items-center gap-2 mt-1.5">
                          {!!meta.score && <span className="text-[12px] font-bold text-amber">{meta.score.toFixed(1)} 分</span>}
                          {episodes.length > 0 && <span className="text-[10.5px] text-mut">共 {episodes.length} 集</span>}
                        </div>
                        <div className="flex gap-3 mt-2 text-[10.5px] text-mut">
                          <span>点赞 {fmt(meta.like)}</span>
                          <span>收藏 {fmt(meta.collect)}</span>
                          <span>评论 {fmt(meta.comment)}</span>
                        </div>
                      </div>
                    </div>

                    {/* 作者 + 关注 */}
                    <div className="mt-4 flex items-center gap-2.5 rounded-(--r-md) bg-s2 p-2.5">
                      <Avatar size={34} name={meta.author} hue={220} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-semibold text-on truncate">{meta.author}</div>
                        <div className="text-[10px] text-mut">作者</div>
                      </div>
                      {meta.authorId > 0 && (
                        <button onClick={onFollow}
                          className={`h-7 px-3 rounded-full text-[11px] font-semibold pressable ${store.follows.includes(meta.authorId) ? "bg-s3 text-mut" : "bg-primary text-on-primary"}`}>
                          {store.follows.includes(meta.authorId) ? "已关注" : "+ 关注"}
                        </button>
                      )}
                    </div>

                    {/* 简介 */}
                    <div className="mt-4">
                      <div className="text-[11px] font-semibold text-dim mb-1.5">简介</div>
                      <p className="text-[11.5px] leading-relaxed text-mut whitespace-pre-wrap">{meta.desc || "暂无简介"}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Sheet>
        </>
      )}
      </div>
      {!isDesktop && !fs && !clean && !controlsLocked && active && (
        <div className="absolute right-3 z-40 flex items-center gap-2" style={{ top: "calc(var(--sat, 0px) + 6px)" }}>
          <button onClick={() => setMuted(m => !m)} aria-label={muted ? "取消静音" : "静音"}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1">
            {muted ? <IVolMute size={17} /> : <IVol size={17} />}
          </button>
          <button onClick={lockControls} aria-label="锁定播放控制" title="锁定播放控制" aria-pressed={false}
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ILockF size={17} /></button>
          <button onClick={() => store.setTab("search")} aria-label="搜索"
            className="hg-chip w-9 h-9 rounded-full flex items-center justify-center pressable elev-1"><ISearch size={18} /></button>
        </div>
      )}
      {controlsLocked && <PlaybackLock active={active} onUnlock={() => { setControlsLocked(false); wake(); }} />}
    </div>
  );
}
