import type { MediaFragment } from '../loader/fragment';

export type AutoCameraItem = {
  x: number;
  y: number;
  focus: number;
  /**
   * reserved[0]: frameTime in integer milliseconds from the owning media
   * fragment start. AlgoDataController converts to seconds internally for
   * time-based lookup; `AutoCameraItem.reserved` keeps the raw integer
   * milliseconds as delivered by the algo side.
   * Valid frameTime sequences start at 0 and strictly increase.
   */
  reserved: [number, number, number, number];
};

export type TrackItem = {
  trackId: number;
  score: number;
  box: [number, number, number, number];
  reserved: [number, number, number, number];
};

export type DetItem = {
  classId: number;
  score: number;
  box: [number, number, number, number];
  reserved: [number, number, number, number];
};

export type FrameItem = {
  frameIdx: number;
  autoCameras: AutoCameraItem;
  tracks: TrackItem[];
  detections: DetItem[];
};

export type AipdMessage = {
  version: number;
  chunkIndex: number;
  frameSize: number;
  frameRate?: number;
  frames: FrameItem[];
};

export type AlgoChunk = {
  fragSn: number;
  algoUrl: string;
  chunkIndex: number;
  frameSize: number;
  frameRate: number;
  startFrameIndex: number;
  frames: FrameItem[];
};

export type AlgoFrameContext = {
  frame: FrameItem;
  chunk: AlgoChunk;
  frag: MediaFragment;
  fragSn: number;
  chunkIndex: number;
  localFrameIndex: number;
  frameRate: number;
  frameSize: number;
  mediaTime: number;
  localTime: number;
  /**
   * Matched algo frame's own time anchor in seconds from the owning media
   * fragment start, when supplied by autoCameras.reserved[0]. Undefined means
   * time lookup fell back to frameRate-based indexing. When fallback is true,
   * this may be the last valid frameTime used for the clamped frame.
   */
  frameTime?: number;
  /**
   * 命中前片末帧 fallback 时为 true，否则不存在（保持调用方不感知）。
   * 仅在 `hls.config.algoBoundaryFallbackEnabled = true` 且当前 time 落在两片
   * PTS 缝隙内时可能出现。调试面板可借此区分"真实帧"与"沿用上一帧"。
   */
  fallback?: boolean;
};

/**
 * 流级一次性测距元数据。
 *
 * 来源：m3u8 中名为 `*__algo_distance.ts` 的伪分片（整流唯一一个），
 * 内容为 MessagePack 编码的 fixarray(5)。
 *
 * 当前已确认语义：
 * - `matrix`: 3x3 单应矩阵（row-major），用于把屏幕坐标映射到世界坐标做距离测算。
 *
 * TODO(算法侧): 其余字段算法侧暂未给出字段名，先整体保留在 `raw` 数组里。
 *   raw[0]: 推测为 version 数值
 *   raw[1]: 推测为某 boolean 标志
 *   raw[2]: 推测为某 boolean 标志
 *   raw[3]: 与 `matrix` 同源（即 9 元素的单应矩阵 float64 数组）
 *   raw[4]: 15 元数组，含分辨率/FPS/角度/画幅参数等
 *   字段名敲定后将以非破坏方式补充命名字段，`raw` 始终保留。
 */
export type AlgoDistanceData = {
  /**
   * 3x3 单应矩阵，row-major，长度恒为 9。
   * 加载成功后由 controller 用 `Object.freeze` 冻结，运行时尝试写入会静默失败
   * 或在严格模式下抛错；类型声明为 readonly 数组以在编译期约束消费者。
   */
  readonly matrix: readonly number[];
  /**
   * 原始 MessagePack 解码结果，长度 ≥ 5（前向兼容算法侧后续追加字段），
   * 结构见模块顶部 TODO。同样在加载成功后被冻结。
   */
  readonly raw: readonly unknown[];
};
