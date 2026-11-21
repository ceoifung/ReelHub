/**
 * 浏览器预览 mock：无 Tauri 宿主时注入最小 invoke，便于核对播放浮层 UI。
 * 仅在 DEV + 非 Tauri 环境生效。
 */
import type { Detail, Paged, PlayInfo, VideoCard } from "../types";

/* 公开可播 HLS，便于浏览器预览（无 hg 本地协议） */
const SAMPLE_HLS = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";

const cards: VideoCard[] = [
  {
    id: 1001,
    title: "高三爱情故事",
    cover: "",
    description: "校园里的暧昧与错过，毕业前的最后一封信。",
    tags: ["现代", "校园", "同学"],
    score: 9.6,
    episode_count: 42,
    total_episodes: 42,
    hot: 1280000,
    like_count: 396000,
    collect_count: 108000,
    comment_count: 2717,
    is_finished: false,
    is_original: 1,
    author: { id: 88, name: "苗果官方" },
  },
  {
    id: 1002,
    title: "重生之商业帝国",
    cover: "",
    description: "带着记忆回到十八岁，这一次他要改写命运。",
    tags: ["重生", "都市"],
    score: 9.2,
    episode_count: 80,
    total_episodes: 80,
    hot: 880000,
    like_count: 210000,
    collect_count: 64000,
    comment_count: 1520,
    is_finished: false,
    is_original: 1,
    author: { id: 91, name: "剧场一号" },
  },
];

function detailOf(id: number): Detail {
  const card = cards.find((c) => c.id === id) || cards[0];
  const eps = Array.from({ length: card.total_episodes }, (_, i) => ({
    ep_num: i + 1,
    title: `第 ${i + 1} 集`,
    duration: 90,
    status: 1,
  }));
  return {
    id: card.id,
    title: card.title,
    description: card.description || "",
    cover: card.cover,
    tags: card.tags,
    score: card.score,
    episode_count: card.episode_count,
    total_episodes: card.total_episodes,
    episodes: eps,
    counts: {
      collect: card.collect_count,
      comment: card.comment_count,
      hot: card.hot,
      like: card.like_count,
    },
    author: { id: card.author?.id || 1, name: card.author?.name || "黄果短剧" },
    is_finished: card.is_finished,
    is_original: card.is_original,
  };
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function handler(cmd: string, args?: Record<string, unknown>): unknown {
  switch (cmd) {
    case "app_boot":
      return { user: null, logged_in: false, base: "https://example.invalid", strict_security: false };
    case "api_feed": {
      const page = Number(args?.page || 1);
      const size = Number(args?.size || 10);
      const res: Paged<VideoCard> = {
        items: cards,
        pagination: { page, pages: 1, size, total: cards.length },
      };
      return res;
    }
    case "api_video":
      return detailOf(Number(args?.id));
    case "api_play": {
      const info: PlayInfo = {
        id: Number(args?.id),
        ep_num: Number(args?.ep || 1),
        duration: 15,
        title: "预览集",
        video_url: SAMPLE_HLS,
      };
      return info;
    }
    case "api_comments":
    case "api_post_comments":
      return { items: [], pagination: { page: 1, pages: 1, size: 20, total: 0 }, total: 0 };
    case "line_state":
      return { current: "https://example.invalid", fixed: [], mirrors: [] };
    case "check_update":
      return { has_update: false };
    case "debug_log":
    case "cache_clear":
    case "security_set":
    case "api_like":
    case "api_collect":
    case "api_follow":
    case "api_logout":
      return { ok: true };
    case "net_diag":
      return { ok: true, latency_ms: 12 };
    default:
      return null;
  }
}

export function installBrowserMock() {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: InvokeFn };
    __HG_BROWSER_MOCK__?: boolean;
  };
  if (w.__TAURI_INTERNALS__ || w.__HG_BROWSER_MOCK__) return;
  w.__HG_BROWSER_MOCK__ = true;
  w.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => handler(cmd, args),
  };

  // 强制走移动端壳，便于核对红果式竖屏播放浮层
  Object.defineProperty(navigator, "userAgent", {
    get: () =>
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    configurable: true,
  });
  Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5, configurable: true });
}
