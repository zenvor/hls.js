import type { MediaFragment } from '../loader/fragment';

export type AutoCameraItem = {
  x: number;
  y: number;
  focus: number;
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
};
