// Vercel Node.js Function. 환경변수는 브라우저로 전달하지 않습니다.
const MAX_BODY_BYTES = 16384;
const MAX_RESPONSE_BYTES = 262144;
const UPSTREAM_TIMEOUT_MS = 25000;

function reply(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(payload);
}

async function readBody(req) {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  if (req.body !== undefined) {
    const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8')
      : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    return JSON.parse(text);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readLimitedText(response) {
  if (Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES) throw new Error('UPSTREAM_FORMAT');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('UPSTREAM_FORMAT');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function callAppsScript(url, secret, action, order, signal) {
  let response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret, action, order }),
    redirect: 'manual',
    signal
  });
  // ContentService는 결과를 Google의 일회성 URL로 돌려줍니다.
  // 그 URL에는 GET만 보내고 비밀키·주문 본문을 재전송하지 않습니다.
  for (let i = 0; i < 3 && [301, 302, 303].includes(response.status); i++) {
    const location = response.headers.get('location');
    if (!location) throw new Error('UPSTREAM_ACCESS');
    const target = new URL(location, url);
    if (target.protocol !== 'https:' || target.hostname !== 'script.googleusercontent.com' ||
        target.username || target.password || target.port) {
      throw new Error('UPSTREAM_ACCESS');
    }
    if (response.body) await response.body.cancel();
    response = await fetch(target.href, { method: 'GET', redirect: 'manual', signal });
  }
  if (!response.ok) throw new Error('UPSTREAM_ACCESS');
  if (!(response.headers.get('content-type') || '').includes('application/json')) {
    throw new Error('UPSTREAM_ACCESS');
  }
  const result = JSON.parse(await readLimitedText(response));
  if (!result || typeof result.ok !== 'boolean') throw new Error('UPSTREAM_FORMAT');
  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(res, 405, { ok: false, message: '지원하지 않는 요청입니다.' });
  }
  // 외부 웹페이지에서 브라우저를 통해 보내는 교차 출처 요청을 차단합니다.
  // 사용자 인증이나 봇 방지 기능은 아니며 기존 공개 구매 방식은 유지합니다.
  const origin = req.headers.origin;
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return reply(res, 403, { ok: false, message: '편의점 페이지에서 요청해 주세요.' });
  }
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== req.headers.host || !['https:', 'http:'].includes(parsed.protocol)) throw new Error();
    } catch {
      return reply(res, 403, { ok: false, message: '편의점 페이지에서 요청해 주세요.' });
    }
  }
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return reply(res, 415, { ok: false, message: '요청 형식이 올바르지 않습니다.' });
  }
  let body;
  try { body = await readBody(req); }
  catch (error) {
    return reply(res, error.message === 'BODY_TOO_LARGE' ? 413 : 400,
      { ok: false, message: '요청 데이터가 올바르지 않습니다.' });
  }
  if (!body || !['getStoreData', 'submitOrder'].includes(body.action)) {
    return reply(res, 400, { ok: false, message: '지원하지 않는 작업입니다.' });
  }
  let order;
  if (body.action === 'submitOrder') {
    if (!body.order || typeof body.order !== 'object' || Array.isArray(body.order)) {
      return reply(res, 400, { ok: false, message: '구매 요청이 올바르지 않습니다.' });
    }
    order = {};
    for (const key of ['name', 'studentId', 'orderId', 'quantities', 'expectedTotal', 'paymentConfirmed']) {
      order[key] = body.order[key];
    }
  }
  const url = (process.env.APPS_SCRIPT_URL || '').trim();
  const secret = (process.env.API_SECRET || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url) || secret.length < 32) {
    return reply(res, 503, { ok: false, message: '서버 연결 설정을 확인해 주세요.' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const result = await callAppsScript(url, secret, body.action, order, controller.signal);
    if (!result.ok) {
      const message = ['UNAUTHORIZED', 'CONFIG_ERROR'].includes(result.code)
        ? '서버 연결 설정을 확인해 주세요.'
        : result.code === 'ORDER_UNCERTAIN'
          ? '저장 결과를 확인하지 못했습니다. 같은 주문으로 다시 확인해 주세요.'
          : '재고 또는 서버 상태를 확인해 주세요.';
      return reply(res, 502, { ok: false, message });
    }
    if (body.action === 'getStoreData' && (!result.data || !Array.isArray(result.data.products))) {
      throw new Error('UPSTREAM_FORMAT');
    }
    if (body.action === 'submitOrder' && (!result.data || typeof result.data.success !== 'boolean')) {
      throw new Error('UPSTREAM_FORMAT');
    }
    return reply(res, 200, { ok: true, data: result.data });
  } catch (error) {
    // Google 로그인 HTML, 오류 페이지, URL, 비밀키, 주문 내용은 응답·로그에 노출하지 않습니다.
    const timeout = controller.signal.aborted;
    const message = timeout
      ? '서버 응답이 지연되고 있습니다. 잠시 후 다시 확인해 주세요.'
      : '서버에 연결하지 못했습니다. 관리자에게 연결 상태를 확인해 주세요.';
    return reply(res, timeout ? 504 : 502, { ok: false, message });
  } finally {
    clearTimeout(timer);
  }
};
