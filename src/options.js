// Saves options to chrome.storage
const saveOptions = () => {
  const api_key = document.getElementById('api_key').value;
  const api_url = document.getElementById('api_url').value;
  const model_name = document.getElementById('model_name').value;

  chrome.storage.sync.set(
    {
      api_key: api_key,
      api_url: api_url,
      model_name: model_name,
    },
    () => {
      const status = document.getElementById('status');
      status.textContent = 'Settings saved.';
      status.className = 'success';
      setTimeout(() => {
        status.textContent = '';
        status.className = '';
      }, 1500);
    }
  );
};

const restoreOptions = () => {
  chrome.storage.sync.get(
    {
      api_key: 'ollama',
      api_url: 'http://localhost:11434/v1',
      model_name: 'llama3.2:1b',
    },
    (items) => {
      document.getElementById('api_key').value = items.api_key;
      document.getElementById('api_url').value = items.api_url;
      document.getElementById('model_name').value = items.model_name;
    }
  );
};

const testConnection = async () => {
  const api_url = document.getElementById('api_url').value;
  const model_name = document.getElementById('model_name').value;
  const api_key = document.getElementById('api_key').value;
  const status = document.getElementById('status');

  status.textContent = 'Testing Ollama...';
  status.className = '';

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (api_key && api_key !== 'ollama') {
      headers.Authorization = `Bearer ${api_key}`;
    }

    const modelsEndpoint = toModelsUrl(api_url);
    const modelsResponse = await fetch(modelsEndpoint, {
      method: 'GET',
      headers,
    });
    const modelsPayload = await parseResponse(modelsResponse);
    if (!modelsResponse.ok) {
      throw new Error(`Models endpoint failed: ${modelsPayload.detail}`);
    }

    const endpoint = toChatCompletionsUrl(api_url);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model_name,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
      }),
    });

    const parsed = await parseResponse(response);
    if (!response.ok) {
      throw new Error(`Chat endpoint failed: ${parsed.detail}`);
    }

    const content = parsed.data?.choices?.[0]?.message?.content?.trim() || '';
    status.textContent = `Success! Models + Chat endpoints work. Model response: ${
      content.slice(0, 80) || 'OK'
    }`;
    status.className = 'success';
  } catch (err) {
    status.textContent = `Failed: ${err.message}. Add chrome-extension://${chrome.runtime.id} to OLLAMA_ORIGINS, restart Ollama, then retry.`;
    status.className = 'error';
  }
};

async function parseResponse(response) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  const detail = data?.error?.message || text || `HTTP ${response.status}`;
  return { data, detail };
}

function toModelsUrl(baseUrl) {
  const normalized = (baseUrl || '').replace(/\/+$/, '');
  if (normalized.endsWith('/v1')) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

function toChatCompletionsUrl(baseUrl) {
  const normalized = (baseUrl || '').replace(/\/+$/, '');
  if (normalized.endsWith('/v1')) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
document.getElementById('test').addEventListener('click', testConnection);
