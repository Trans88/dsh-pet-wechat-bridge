export function memoryRequest(text) { return /^\/(?:memories|记忆)$/i.test(text) || /^(?:你(?:现在|目前|还)?(?:都)?记得我(?:些|些什么|什么)|(?:查看|看看|列出)(?:你(?:的)?)?(?:当前|现在|目前)?(?:的)?记忆)[？?。！!\s]*$/.test(text); }
export function memorySnapshot(store, scope) {
  const history = store.history(scope, 24);
  return { memories: store.memories(scope), context: history.map(({ id, role, text, created, origin, sources, search, image }) => ({ id, role, text, created, origin, sources, search, hasImage: Boolean(image) })),
    notes: scope === 'web:owner' ? store.notesByIds(history.flatMap(m => (m.sources || []).filter(s => s.type !== 'web').map(s => s.id))) : [] };
}
export function describeMemory(store, scope) {
  const memories = store.memories(scope);
  if (!memories.length) return '这个会话还没有单独保存的长期记忆。最近聊天仍会作为上下文参考；在小窝「记忆」页可以查看，或发 /remember 加上想让我记住的内容。';
  return `这个会话保存了 ${memories.length} 条长期记忆：\n` + memories.slice(0, 20).map((m, i) => `${i + 1}. ${m.text.slice(0, 250)}${m.text.length > 250 ? '…' : ''}`).join('\n') +
    '\n\n小窝「记忆」页可以查看完整内容、编辑或删除；近期聊天记录会单独作为上下文参考。';
}
