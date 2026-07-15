/**
 * AgentRouter Billing SSE Filter Plugin
 *
 * AgentRouter 在 SSE 流末尾发送 `data: {"billing":{...},"object":"billing.summary"}`
 * 导致 @ai-sdk/openai-compatible 的 Zod 校验器报 `Type validation failed`。
 *
 * 本插件在 fetch 层拦截 agentrouter.org 的响应，从 SSE 流中过滤掉 billing 消息。
 */
const AGENTROUTER_HOST = 'agentrouter.org';

function isAgentRouterUrl(url) {
  try {
    const p = typeof url === 'string' ? new URL(url) : new URL(url.url ?? url.href ?? String(url));
    return p.hostname === AGENTROUTER_HOST || p.hostname.endsWith('.' + AGENTROUTER_HOST);
  } catch { return false; }
}

/**
 * 过滤 SSE 流中的 billing.summary 消息。
 * `data: {"billing":{...},"object":"billing.summary"}` 整个行需要被移除。
 */
function sanitizeSseBody(body) {
  if (!body) return body;

  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let carry = '';

  return new Response(
    new ReadableStream({
      async start(controller) {
        const reader = body.getReader();
        function push() {
          reader.read().then(({ done, value }) => {
            if (done) {
              if (carry.length > 0) {
                controller.enqueue(enc.encode(carry));
              }
              controller.close();
              return;
            }

            const text = carry + dec.decode(value, { stream: true });
            const lines = text.split('\n');
            // 最后一个可能是片段，保留到下一次
            carry = lines.pop() ?? '';

            const filtered = lines
              .filter(line => {
                const trimmed = line.trim();
                // 过滤 data: null 和 data: {"billing":...}
                if (trimmed === 'data: null' || trimmed === 'data:null') return false;
                if (trimmed.startsWith('data:') && trimmed.includes('"object":"billing.summary"')) return false;
                if (trimmed.startsWith('data:') && trimmed.includes('"billing"')) return false;
                return true;
              })
              .join('\n');

            if (filtered.length > 0) {
              controller.enqueue(enc.encode(filtered + '\n'));
            }

            push();
          }).catch(e => controller.error(e));
        }
        push();
      }
    }),
    { status: 200, statusText: 'OK' }
  );
}

function patchFetchOnce() {
  if (globalThis.__agentrouter_billing_filter_patched__) return;
  globalThis.__agentrouter_billing_filter_patched__ = true;

  const origFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' || input instanceof URL
        ? input
        : input?.url;
      if (!url || !isAgentRouterUrl(url)) {
        return origFetch(input, init);
      }

      const res = await origFetch(input, init);
      const ct = res.headers.get('content-type') ?? '';

      if (res.ok && ct.includes('text/event-stream') && res.body) {
        return sanitizeSseBody(res.body);
      }
      return res;
    } catch {
      return origFetch(input, init);
    }
  };
}

export const AgentRouterBillingFilterPlugin = async ({ client }) => {
  patchFetchOnce();
  try {
    await client.app.log({
      body: {
        service: 'agentrouter-billing-filter',
        level: 'info',
        message: 'AgentRouter billing SSE filter installed'
      }
    });
  } catch {}
  return {};
};
