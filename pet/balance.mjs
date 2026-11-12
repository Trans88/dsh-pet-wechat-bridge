import { BridgeError, requestJSON } from '../lib.mjs';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const amount = value => typeof value === 'string' && /^-?\d{1,15}(?:\.\d{1,10})?$/.test(value);

export function supportsBalance(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash && /^\/(?:v1\/?|)?$/.test(url.pathname);
  } catch { return false; }
}

export async function queryBalance(provider, fetcher, signal) {
  if (!supportsBalance(provider.baseUrl)) throw new BridgeError('余额查询仅支持 DeepSeek 官方 API 地址：https://api.deepseek.com 或 https://api.deepseek.com/v1。', 'balance-unsupported');
  if (!provider.apiKey) throw new BridgeError('请先保存 DeepSeek API Key，再查询余额。', 'balance-no-key');
  try {
    signal?.throwIfAborted();
    const data = await requestJSON(BALANCE_URL, {
      method: 'GET', headers: { Authorization: `Bearer ${provider.apiKey}` }, timeoutMs: 10000, signal,
    }, fetcher);
    signal?.throwIfAborted();
    if (typeof data?.is_available !== 'boolean' || !Array.isArray(data.balance_infos) || !data.balance_infos.length || data.balance_infos.length > 2) throw new Error('Invalid balance');
    const currencies = new Set();
    const balances = data.balance_infos.map(info => {
      if (!info || !['CNY', 'USD'].includes(info.currency) || currencies.has(info.currency) ||
          ![info.total_balance, info.granted_balance, info.topped_up_balance].every(amount)) throw new Error('Invalid balance');
      currencies.add(info.currency);
      return { currency: info.currency, total: info.total_balance, granted: info.granted_balance, toppedUp: info.topped_up_balance };
    });
    const notice = !data.is_available ? '账户余额不足，暂时无法调用模型，请充值后刷新。' :
      balances.some(info => info.currency === 'CNY' && Number(info.total) < 5) ? '人民币可用余额低于 5 元，请留意充值。' : '';
    return { isAvailable: data.is_available, balances, checkedAt: new Date().toISOString(), notice };
  } catch (error) {
    const messages = {
      'http-401': '余额查询认证失败，请检查 DeepSeek API Key。',
      'http-403': '余额查询被拒绝，请检查 DeepSeek API Key 和账号权限。',
      'http-402': 'DeepSeek 提示账户余额不足，请前往官方控制台充值后重试。',
      'http-429': '余额查询过于频繁，请稍后重试。',
      aborted: '余额查询超时或已取消，请稍后重试。',
      network: '余额查询连接失败，请检查网络后重试。',
    };
    if (signal?.aborted) throw new BridgeError(messages.aborted, 'aborted');
    throw new BridgeError(messages[error.code] || '暂时无法读取 DeepSeek 余额，服务未返回有效的余额信息，请稍后重试。', 'balance-query-failed');
  }
}

export function balanceCommand(text) {
  const command = text.trim().toLowerCase().replace(/[\s？?！!。]/g, '');
  return ['/余额', '/balance'].includes(command) ||
    /^(?:请|帮我)?(?:(?:查询|查看|查|看)(?:一下|下)?|看看|查查)?(?:当前的?|现在的?|我的)?(?:deepseek|模型|api|账户)?余额(?:是多少|有多少|还有多少|还剩多少)?(?:吗|呢)?$/.test(command) ||
    /^(?:当前|现在)?(?:deepseek|模型|api)?(?:还剩|还有)(?:多少余额|多少钱|多少额度)(?:吗|呢)?$/.test(command);
}

export function describeBalance(result) {
  const lines = ['查到啦，当前 DeepSeek API 账户余额：'];
  for (const info of result.balances) {
    const unit = info.currency === 'CNY' ? '元（CNY）' : '美元（USD）';
    lines.push(`可用余额：${info.total} ${unit}；充值余额：${info.toppedUp}；赠送余额：${info.granted}。`);
  }
  if (result.notice) lines.push(result.notice);
  lines.push(`查询时间：${new Date(result.checkedAt).toLocaleString('zh-CN', { hour12: false })}。这是账户共享余额；再次发送「查询余额」可刷新。`);
  return lines.join('\n');
}
