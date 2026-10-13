'use strict';

// Small Ollama REST client (https://github.com/ollama/ollama/blob/main/docs/api.md).
// Uses node:http directly so long model loads are never cut off by fetch timeouts.

const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');
const { abortError } = require('./util');

const DEFAULT_URL = 'http://127.0.0.1:11434';

class OllamaError extends Error {
  constructor(message, { code = 'error', hint = '', status = 0 } = {}) {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.hint = hint;
    this.status = status;
  }
}

function normalizeBaseUrl(url) {
  let u = String(url || '').trim() || DEFAULT_URL;
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

function unreachable(baseUrl, cause) {
  return new OllamaError(`Can't reach Ollama at ${baseUrl}`, {
    code: 'unreachable',
    hint:
      'Make sure Ollama is installed and running: start the Ollama app from the Start menu, or run `ollama serve` in a terminal. ' +
      'Download it from https://ollama.com/download. If Ollama runs on another address, change the URL in Settings.' +
      (cause ? ` (${cause})` : ''),
  });
}

function mapApiError(message, status, model) {
  const msg = String(message || `HTTP ${status}`);
  if (/does not support tools/i.test(msg)) return new OllamaError(msg, { code: 'no-tools', status });
  if (/does not support thinking|think value/i.test(msg)) return new OllamaError(msg, { code: 'no-thinking', status });
  if (status === 404 || /not found/i.test(msg)) {
    return new OllamaError(msg, {
      code: 'model-missing',
      status,
      hint: model ? `Download it with: ollama pull ${model}` : 'Pick an installed model in the model selector.',
    });
  }
  if (/memory|out of memory|CUDA|cudaMalloc|VRAM/i.test(msg)) {
    return new OllamaError(msg, {
      code: 'memory',
      status,
      hint: 'The model does not fit in memory. Try a smaller model (e.g. a 7B/8B model) or lower the context window in Settings.',
    });
  }
  return new OllamaError(msg, { code: 'api', status });
}

class OllamaClient {
  constructor(getBaseUrl = () => DEFAULT_URL) {
    this.getBaseUrl = typeof getBaseUrl === 'function' ? getBaseUrl : () => getBaseUrl;
    this.infoCache = new Map();
  }

  get baseUrl() {
    return normalizeBaseUrl(this.getBaseUrl());
  }

  _request(pathname, { method = 'GET', body, signal, timeoutMs = 0 } = {}) {
    const base = this.baseUrl;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      let url;
      try {
        url = new URL(base + pathname);
      } catch {
        return reject(new OllamaError(`Invalid Ollama URL: ${base}`, { code: 'bad-url', hint: 'Fix the Ollama URL in Settings, e.g. http://127.0.0.1:11434' }));
      }
      const lib = url.protocol === 'https:' ? https : http;
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = lib.request(
        url,
        {
          method,
          headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
        },
        (res) => {
          cleanup();
          resolve(res);
        },
      );
      let timer = null;
      const onAbort = () => {
        req.destroy(abortError());
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
      };
      if (timeoutMs) {
        timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (err) => {
        cleanup();
        if (err.name === 'AbortError' || signal?.aborted) return reject(abortError());
        reject(unreachable(base, err.code || err.message));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  async _json(pathname, opts = {}) {
    const res = await this._request(pathname, { timeoutMs: 15000, ...opts });
    const text = await readAll(res);
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (res.statusCode >= 400) throw mapApiError(data?.error, res.statusCode, opts.body?.model || opts.body?.name);
    return data;
  }

  async version() {
    const data = await this._json('/api/version', { timeoutMs: 5000 });
    return data.version || 'unknown';
  }

  async status() {
    try {
      const version = await this.version();
      return { ok: true, version, url: this.baseUrl };
    } catch (err) {
      return { ok: false, url: this.baseUrl, error: err.message, hint: err.hint || '' };
    }
  }

  async listModels() {
    const data = await this._json('/api/tags');
    return (data.models || [])
      .map((m) => ({
        name: m.name || m.model,
        size: m.size || 0,
        modifiedAt: m.modified_at,
        family: m.details?.family || '',
        parameterSize: m.details?.parameter_size || '',
        quantization: m.details?.quantization_level || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Model capabilities. Uses the `capabilities` field from /api/show (Ollama >= 0.6)
   * and falls back to inspecting the chat template on older versions.
   */
  async modelInfo(name) {
    if (!name) return null;
    if (this.infoCache.has(name)) return this.infoCache.get(name);
    const data = await this._json('/api/show', { method: 'POST', body: { model: name }, timeoutMs: 30000 });
    const caps = Array.isArray(data.capabilities) ? data.capabilities : null;
    const template = data.template || '';
    let contextLength = 0;
    for (const [k, v] of Object.entries(data.model_info || {})) {
      if (k.endsWith('.context_length') && typeof v === 'number') contextLength = v;
    }
    const info = {
      name,
      tools: caps ? caps.includes('tools') : /\.Tools\b/.test(template),
      thinking: caps ? caps.includes('thinking') : /\.Thinking|<think>/.test(template),
      vision: caps ? caps.includes('vision') : Array.isArray(data.projector_info) || !!data.projector_info,
      contextLength,
      family: data.details?.family || '',
      parameterSize: data.details?.parameter_size || '',
      quantization: data.details?.quantization_level || '',
    };
    this.infoCache.set(name, info);
    return info;
  }

  /**
   * Stream a chat completion. Yields Ollama chunks: { message: { content, thinking, tool_calls }, done, ... }.
   */
  async *chat(body, signal) {
    const res = await this._request('/api/chat', { method: 'POST', body: { ...body, stream: true }, signal });
    if (res.statusCode >= 400) {
      const text = await readAll(res);
      let msg = text;
      try {
        msg = JSON.parse(text).error || text;
      } catch {
        /* plain text error */
      }
      throw mapApiError(msg, res.statusCode, body.model);
    }
    const decoder = new StringDecoder('utf8');
    let buf = '';
    try {
      for await (const chunk of res) {
        buf += decoder.write(chunk);
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const obj = parseLine(line);
          if (obj.error) throw mapApiError(obj.error, 500, body.model);
          yield obj;
        }
      }
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError') throw abortError();
      if (err instanceof OllamaError) throw err;
      throw new OllamaError(`Connection to Ollama was lost: ${err.message}`, { code: 'unreachable', hint: 'Check that Ollama is still running.' });
    }
    buf += decoder.end();
    if (buf.trim()) {
      const obj = parseLine(buf.trim());
      if (obj.error) throw mapApiError(obj.error, 500, body.model);
      yield obj;
    }
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new OllamaError(`Unexpected response from Ollama: ${line.slice(0, 200)}`, { code: 'api' });
  }
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

module.exports = { OllamaClient, OllamaError, DEFAULT_URL, normalizeBaseUrl };
