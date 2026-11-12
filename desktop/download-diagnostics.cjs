// Preload only in the installer child. Keep credentials, URLs and error messages out of diagnostics.
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (...args) {
  try {
    const response = await originalFetch.apply(this, args);
    if (!response.ok) console.error(`Electron 下载服务器返回 HTTP ${response.status}。`);
    return response;
  } catch (error) {
    const queue = [error], seen = new Set(), codes = new Set();
    while (queue.length && seen.size < 20) {
      const entry = queue.shift();
      if (!entry || typeof entry !== 'object' || seen.has(entry)) continue;
      seen.add(entry);
      if (typeof entry.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(entry.code)) codes.add(entry.code);
      queue.push(entry.cause, ...(Array.isArray(entry.errors) ? entry.errors.slice(0, 20) : []));
    }
    console.error(`Electron 下载网络错误：${[...codes].join(', ') || 'FETCH_FAILED'}。`);
    if (codes.has('ECONNREFUSED')) console.error('连接被拒绝；若使用代理，请确认代理已启动且端口正确。');
    if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) console.error('域名解析失败，请检查网络或 DNS。');
    if ([...codes].some(code => /TIMEOUT|TIMEDOUT/.test(code))) console.error('连接超时，请换用镜像或已启动的 HTTP 代理。');
    throw error;
  }
};
