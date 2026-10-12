/*
 * The YouTube player. Nothing of YouTube loads until a video is played: a video shows its still
 * picture first, and the page is only asked for the player when the reader presses play.
 */

/** What the page can ask of a playing video. */
export interface Player {
  currentTime(): number;
  duration(): number;
  seek(seconds: number): void;
  play(): void;
  pause(): void;
  /** The video's own title, as YouTube has it. Empty until the player knows. */
  title(): string;
  destroy(): void;
}

/** Player states the page acts on, as YouTube numbers them. */
export const STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2 } as const;

interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  playVideo(): void;
  pauseVideo(): void;
  getVideoData(): { title?: string };
  destroy(): void;
}

interface YTNamespace {
  Player: new (el: HTMLElement, options: Record<string, unknown>) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;

/** YouTube's player API, loaded once, the first time a video is played. */
export function youtubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!loading) {
    loading = new Promise<YTNamespace>((resolve, reject) => {
      const earlier = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        earlier?.();
        if (window.YT) resolve(window.YT);
      };
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => {
        loading = null;
        reject(new Error("Couldn't load YouTube. Check your connection and try again."));
      };
      document.head.append(script);
    });
  }
  return loading;
}

/**
 * Puts a player for a video into an element. The player reports when it is ready, when its state
 * changes (playing, paused, ended) and when it can't play the video (YouTube's error code).
 */
export async function mountPlayer(
  el: HTMLElement,
  videoId: string,
  on: { ready: (player: Player) => void; state: (state: number) => void; error: (code: number) => void },
): Promise<void> {
  const YT = await youtubeApi();
  new YT.Player(el, {
    videoId,
    // The privacy-enhanced domain: no cookies are set for the viewer until the video is played.
    host: "https://www.youtube-nocookie.com",
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1, origin: location.origin },
    events: {
      onReady: (e: { target: YTPlayer }) => {
        const player = e.target;
        on.ready({
          currentTime: () => player.getCurrentTime() || 0,
          duration: () => player.getDuration() || 0,
          seek: (s) => player.seekTo(s, true),
          play: () => player.playVideo(),
          pause: () => player.pauseVideo(),
          title: () => player.getVideoData()?.title ?? "",
          destroy: () => player.destroy(),
        });
      },
      onStateChange: (e: { data: number }) => on.state(e.data),
      onError: (e: { data: number }) => on.error(e.data),
    },
  });
}
