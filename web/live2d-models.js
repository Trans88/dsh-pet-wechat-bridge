// Fixed bundled models only. Paths and interaction mapping are authored together.
export const LIVE2D_MODELS = Object.freeze({
  'haru-live2d': {
    root: '/assets/live2d/Haru/', file: 'Haru.model3.json', label: 'Haru，Live2D 官方示例形象',
    pointer: { x: 24, y: 16, body: 6 },
    smileEyes: ['ParamEyeLSmile', 'ParamEyeRSmile'],
    actions: { pat: ['TapBody', 0], feed: ['TapBody', 1], hug: ['TapBody', 0], play: ['TapBody', 2], dance: ['TapBody', 3], wake: ['TapBody', 1] },
  },
  'taolinghu-live2d': {
    root: '/assets/live2d/Taolinghu/', file: 'Taolinghu.model3.json', label: '桃铃狐，专属 Live2D 形象',
    pointer: { x: 18, y: 12, body: 4 },
    smileEyes: [],
    actions: { pat: ['Pat', 0], feed: ['Feed', 0], hug: ['Hug', 0], play: ['Play', 0], dance: ['Dance', 0], wake: ['Wake', 0] },
  },
});
