# egjs-view360-fork Usage Guide (Detailed)

## 1. 项目定位与适用场景

`egjs-view360-fork` 是 `egjs-view360` 的内部定制版本，用于全景图、全景视频、广角实时投影场景，并支持在 Vue3 Demo 中的自动运镜、HLS 播放和广角矫正功能。

适用场景包括：

- 全景图/全景视频播放器
- 实时广角视频矫正与投影
- 基于算法帧的自动运镜（CameraPath）

## 2. 仓库结构

- 核心库：`packages/view360`
- 框架封装：`packages/vue3-view360`、`packages/react-view360`、`packages/ngx-view360`、`packages/vue-view360`、`packages/svelte-view360`
- Vue3 Demo：`packages/vue3-view360/demo`
- 文档与展示站点：`demo`

## 3. 本地开发与构建

安装依赖（仓库根目录）：

```bash
npm install
```

构建核心库（必要时）：

```bash
npm run packages:build-core
```

完整构建（包含所有子包）：

```bash
npm run packages:build
```

启动 Vue3 Demo（推荐快速验证）：

```bash
npm run start --prefix packages/vue3-view360
```

Demo 入口和说明见：`packages/vue3-view360/demo/README.md`

构建文档站点（可选）：

```bash
npm run demo:build
```

## 4. 在业务项目中使用（核心库）

纯 JS/TS 用法（View360 + Projection）：

```ts
import View360, { EquirectProjection } from '@egjs/view360';

const container = document.getElementById('viewer')!;

// 中文注释：创建投影并传入资源
const projection = new EquirectProjection({
  src: '/assets/pano.jpg',
});

// 中文注释：创建 View360 实例
const viewer = new View360(container, { projection });

// 中文注释：图片/暂停视频需要手动渲染一帧
viewer.on('ready', () => {
  viewer.renderFrame(0);
});
```

常用投影类型（均从 `@egjs/view360` 导出）：

- `EquirectProjection`（全景图/全景视频）
- `CubemapProjection` / `CubestripProjection`
- `CylindricalProjection`
- `EquiangularProjection`
- `LittlePlanetProjection`
- `StereoEquiProjection`
- `WideAngleCorrectionProjection`
- `WideAngleRealtimeProjection`

## 5. Vue3 使用方式（组件化）

Vue3 项目建议使用 `@egjs/vue3-view360`：

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { View360, WideAngleRealtimeProjection } from '@egjs/vue3-view360';

const projection = ref(
  new WideAngleRealtimeProjection({
    src: '/assets/wide-angle.mp4',
    video: {
      autoplay: false,
      muted: true,
      loop: false,
    },
    correction: {
      mode: 'erp',
      yaw: 0,
      pitch: 0,
      roll: 0,
      hfov: 165,
      vfov: 53,
      fisheyeFov: 180,
    },
  }),
);

const view360Ref = ref<InstanceType<typeof View360> | null>(null);

const onReady = () => {
  // 中文注释：图片或暂停视频需要手动渲染一帧
  view360Ref.value?.renderFrame(0);
};
</script>

<template>
  <View360 ref="view360Ref" :projection="projection" @ready="onReady" />
</template>
```

## 6. 算法分片视频流播放（重点）

本节聚焦“包含算法分片的视频流”播放方式，适用于 `.m3u8` 资源中混入算法分片（用于自动运镜或其它算法数据）的场景。

核心使用步骤：

1. `src` 指向 `.m3u8`。
2. 在 `video.hlsConfig` 中启用 HLS。
3. 在 `video.hlsConfig.config` 中开启并配置算法分片相关参数。
4. 若需要自动运镜，设置 `cameraPath` 帧数据并启用。

### 6.1 基础 HLS 配置

```ts
new WideAngleRealtimeProjection({
  src: '/assets/stream.m3u8',
  video: {
    autoplay: false,
    muted: true,
    hlsConfig: {
      enabled: true,
      // 中文注释：必要时强制使用 hls.js（例如 Safari 默认走原生 HLS）
      // force: true,
      // 中文注释：透传 hls.js 配置
      // config: { maxBufferLength: 30 }
    },
  },
  correction: {
    mode: 'erp',
    yaw: 0,
    pitch: 0,
    roll: 0,
    hfov: 165,
    vfov: 53,
    fisheyeFov: 180,
  },
});
```

### 6.2 算法分片配置（hls.js-fork 扩展）

```ts
hlsConfig: {
  enabled: true,
  config: {
    // 中文注释：开启算法分片数据
    algoDataEnabled: true,
    // 中文注释：算法分片文件匹配规则（统一包含 _dat.ts）
    algoSegmentPattern: /_dat\.ts$/i,
    // 中文注释：算法分片预加载数量
    algoPreloadCount: 2,
    // 中文注释：算法分片缓存上限（<=0 表示不淘汰，长播时会导致内存无限增长）
    // 推荐 500，约覆盖 500 × 分片时长 的时间窗口（2s 分片 ≈ 16 min 40 s）
    algoCacheSize: 500,
    // 中文注释：算法帧率（需与实际数据一致）
    algoFrameRate: 30,
  },
}
```

说明：上述字段属于 `hls.js-fork` 的扩展配置，请确保项目实际依赖的是 fork 版本。

### 6.3 与算法分片相关的关键 API

以下 API 与算法分片播放直接相关：

- `new WideAngleRealtimeProjection({ src, video, correction })`
- `video.hlsConfig.enabled`
- `video.hlsConfig.force`
- `video.hlsConfig.config`（透传 `hls.js` 及 `hls.js-fork` 配置）
- `viewer.cameraPath.setFrames(frames, fps)`（传入算法帧数据）
- `viewer.cameraPath.enable()`（启用自动运镜）
- `viewer.cameraPath.setTimeOffset(offset)`（校正算法时间与视频时间偏移）

### 6.4 相关事件

文档中与播放流程直接相关的事件只有 `ready`：

- `ready`：初始化完成后触发，图片或暂停视频需在此事件中调用 `renderFrame(0)`。

### 6.5 hls.js-fork 事件（算法分片）

如果你在业务中直接使用 `hls.js-fork`（或可以获取 `Hls` 实例），可监听算法分片事件来感知加载进度与错误状态。
这些事件仅在 `algoDataEnabled = true` 且匹配到算法分片时触发。

- `Hls.Events.ALGO_DATA_LOADING`：算法分片开始加载
- `Hls.Events.ALGO_DATA_LOADED`：算法分片加载并解析完成（`data.chunk` 含算法帧数据）
- `Hls.Events.ALGO_DATA_ERROR`：算法分片加载或解析失败（`data.error`/`data.reason`）

```ts
hls.on(Hls.Events.ALGO_DATA_LOADED, (event, data) => {
  const { chunk } = data;
  const { frames, frameRate, startFrameIndex } = chunk;
  // 中文注释：这里可将算法帧用于自动运镜或其它逻辑
  console.log(frames.length, frameRate, startFrameIndex);
});
```

## 7. 自动运镜（CameraPath）

自动运镜由 `cameraPath` 驱动，数据格式为按帧的 `{ yaw, pitch, zoom }`：

```ts
// 中文注释：设置帧数据并启用自动运镜
viewer.cameraPath.setFrames(frames, 30);
viewer.cameraPath.enable();

// 中文注释：如果算法时间与视频时间有偏差，可设置时间偏移
viewer.cameraPath.setTimeOffset(0.2);

// 中文注释：可调平滑系数，0 表示只走 Motion 插值
viewer.cameraPath.smoothing = 0;
```

关键点：

- 帧数组可用 `CameraFrame[]` 或 `Float32Array`
- `fps` 必须与数据帧率一致
- `canInterrupt` / `disableOnInterrupt` 控制用户拖拽是否打断自动运镜

## 8. 常见注意事项

- `video.autoplay` 生效通常要求 `muted = true`
- 图片或暂停视频需要调用 `renderFrame(0)` 才能看到矫正效果
- 使用 `WideAngleRealtimeProjection` 时，大分辨率可通过 `inputWidth` / `inputHeight` 做缩放
- HLS 在 Safari 上可能走原生解码；如需强制 hls.js，请设置 `hlsConfig.force = true`
