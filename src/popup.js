import './styles.css';
const DIFF_FETCH_TIMEOUT_MS = 15000;
const OLLAMA_TIMEOUT_MS = null;
const REPO_REVIEW_FILE_LIMIT = 25;
const PER_FILE_CHAR_LIMIT = 4000;
const REPO_TOTAL_CHAR_LIMIT = 100000;
const STREAM_RENDER_EVERY_TOKENS = 24;
const STREAM_PAUSE_MS = 30;
let currentReportMeta = {
  mode: 'pr',
  title: '',
  url: '',
  branch: '',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  skippedFiles: 0,
};
let chatHistory = [];

// Render all mermaid diagrams found in #result via the sandboxed iframe.
let _mermaidSandbox = null;
const _mermaidPending = new Map();

function getMermaidSandbox() {
  if (_mermaidSandbox) return _mermaidSandbox;

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sandbox.html');
  iframe.style.cssText = 'display:none;width:0;height:0;border:0;position:absolute;';
  document.body.appendChild(iframe);

  window.addEventListener('message', (event) => {
    const { id, svg, error } = event.data || {};
    if (!id || !_mermaidPending.has(id)) return;
    const { resolve, reject } = _mermaidPending.get(id);
    _mermaidPending.delete(id);
    if (error) reject(new Error(error));
    else resolve(svg);
  });

  _mermaidSandbox = iframe;
  return iframe;
}

async function renderDiagramInSandbox(code) {
  const iframe = getMermaidSandbox();
  return new Promise((resolve, reject) => {
    // Wait for iframe to be ready
    const id = Date.now() + '-' + Math.floor(Math.random() * 99999);
    _mermaidPending.set(id, { resolve, reject });
    const send = () => iframe.contentWindow.postMessage({ id, code }, '*');
    // If iframe is already loaded, send immediately; otherwise wait.
    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
      send();
    } else {
      iframe.addEventListener('load', send, { once: true });
    }
    // Timeout after 10s
    setTimeout(() => {
      if (_mermaidPending.has(id)) {
        _mermaidPending.delete(id);
        reject(new Error('Mermaid sandbox timeout'));
      }
    }, 10000);
  });
}

async function renderMermaidDiagrams() {
  const resultEl = document.getElementById('result');
  if (!resultEl) return;

  const mermaidBlocks = resultEl.querySelectorAll('code.language-mermaid, code.mermaid');
  if (mermaidBlocks.length === 0) return;

  for (const block of mermaidBlocks) {
    const pre = block.parentElement;
    if (pre && pre.tagName.toLowerCase() === 'pre') {
      try {
        const code = block.textContent;
        const svg = await renderDiagramInSandbox(code);

        const container = document.createElement('div');
        container.className = 'mermaid-rendered my-4 p-4 bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto flex justify-center';
        container.innerHTML = svg;
        pre.parentNode.replaceChild(container, pre);
      } catch (err) {
        console.warn('Mermaid render error:', err.message);
        // Leave raw code block as fallback - don't crash
      }
    }
  }
}

function inProgress(active, failed) {
  const btn = document.getElementById('rerun-btn');
  const icon = document.getElementById('status-icon');
  const badge = document.getElementById('stats-badge');

  if (btn) btn.disabled = active;
  if (badge) badge.classList.toggle('hidden', !active);
  
  if (active) {
    if (icon) icon.innerHTML = spinner;
  } else {
    if (icon) {
      icon.innerHTML = failed ? xcircle : checkmark;
    }
  }
}

function setDownloadEnabled(enabled) {
  const downloadBtn = document.getElementById('download-btn');
  if (downloadBtn) {
    downloadBtn.disabled = !enabled;
    downloadBtn.classList.toggle('opacity-50', !enabled);
    downloadBtn.classList.toggle('shadow-none', !enabled);
  }
}

async function getSettings() {
  let settings = await new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        api_key: 'ollama',
        api_url: 'http://localhost:11434/v1',
        model_name: 'llama3.2:1b',
      },
      resolve
    );
  });

  return {
    apiKey: settings['api_key'],
    baseUrl: settings['api_url'],
    model: settings['model_name'],
  };
}

async function createOllamaClient() {
  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    throw new Error('Error loading settings.');
  }

  const headers = {
    'Content-Type': 'application/json',
  };
  if (settings.apiKey && settings.apiKey !== 'ollama') {
    headers.Authorization = `Bearer ${settings.apiKey}`;
  }

  return {
    endpoint: toChatCompletionsUrl(settings.baseUrl),
    model: settings.model,
    headers,
    systemMessage:
      'You are a local programming code reviewer. Provide concise, practical feedback on the provided changes.',
  };
}

async function askOllama(client, prompt, timeoutMs = OLLAMA_TIMEOUT_MS) {
  try {
    const response = await postJsonWithTimeout(
      client.endpoint,
      {
        model: client.model,
        stream: false,
        messages: [
          { role: 'system', content: client.systemMessage },
          { role: 'user', content: prompt },
        ],
      },
      client.headers,
      timeoutMs
    );

    const text = response?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error(
        'Ollama returned an empty response. Check model availability and logs.'
      );
    }
    return text;
  } catch (e) {
    let errorMsg = e.message || 'Unknown error';
    if (errorMsg.includes('403') || errorMsg.includes('Failed to fetch')) {
      errorMsg =
        `Ollama Connection Failed. Allow this extension origin in Ollama and restart Ollama.\n` +
        `Required origin: chrome-extension://${chrome.runtime.id}\n` +
        `Original error: ${errorMsg}`;
    }
    throw new Error(errorMsg);
  }
}

const showdown = require('showdown');
const parseDiff = require('parse-diff');
const converter = new showdown.Converter();
let staticMarkdown = '';
let liveMarkdown = '';

function ensureResultLayout() {
  const resultEl = document.getElementById('result');
  if (!resultEl) return null;
  if (!resultEl.querySelector('#result-static')) {
    resultEl.innerHTML =
      '<div id="result-static"></div><pre id="result-live" class="live-stream hidden"></pre>';
  }
  return resultEl;
}

function renderStaticMarkdown() {
  const resultEl = ensureResultLayout();
  if (!resultEl) return;
  const staticEl = resultEl.querySelector('#result-static');
  const wasNearBottom =
    resultEl.scrollTop + resultEl.clientHeight >= resultEl.scrollHeight - 48;
  staticEl.innerHTML = converter.makeHtml(staticMarkdown);
  if (wasNearBottom) {
    resultEl.scrollTop = resultEl.scrollHeight;
  }
}

function renderMarkdown(markdown) {
  staticMarkdown = markdown;
  liveMarkdown = '';
  const resultEl = ensureResultLayout();
  if (!resultEl) return;
  const liveEl = resultEl.querySelector('#result-live');
  if (liveEl) {
    liveEl.textContent = '';
    liveEl.classList.add('hidden');
  }
  renderStaticMarkdown();
}

function resetRenderedMarkdown(markdown = '') {
  renderMarkdown(markdown);
}

function appendStaticMarkdown(markdown) {
  staticMarkdown += markdown;
  renderStaticMarkdown();
}

function updateLiveMarkdown() {
  const resultEl = ensureResultLayout();
  if (!resultEl) return;
  const liveEl = resultEl.querySelector('#result-live');
  if (!liveEl) return;
  const wasNearBottom =
    resultEl.scrollTop + resultEl.clientHeight >= resultEl.scrollHeight - 48;
  liveEl.classList.remove('hidden');
  liveEl.textContent = liveMarkdown;
  if (wasNearBottom) {
    resultEl.scrollTop = resultEl.scrollHeight;
  }
}

function commitLiveMarkdown() {
  if (!liveMarkdown) return;
  appendStaticMarkdown(liveMarkdown);
  liveMarkdown = '';
  const resultEl = ensureResultLayout();
  if (!resultEl) return;
  const liveEl = resultEl.querySelector('#result-live');
  if (!liveEl) return;
  liveEl.textContent = '';
  liveEl.classList.add('hidden');
}

function getReportContextText() {
  const resultEl = document.getElementById('result');
  if (!resultEl) return '';
  const text = resultEl.innerText || '';
  return text.trim().slice(0, 28000);
}

function appendChatBubble(role, text) {
  const messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function initializeChatIntro() {
  const messagesEl = document.getElementById('chat-messages');
  if (!messagesEl || messagesEl.childElementCount > 0) return;
  appendChatBubble(
    'system',
    'Ask questions about the generated review. I will answer based on the current report.'
  );
}

function toggleChatPanel() {
  const panel = document.getElementById('chat-panel');
  const toggleBtn = document.getElementById('chat-toggle-btn');
  if (!panel || !toggleBtn) return;

  panel.classList.toggle('hidden');
  const isOpen = !panel.classList.contains('hidden');
  toggleBtn.textContent = isOpen ? 'Close Chat' : 'Open Chat';
  initializeChatIntro();
}

async function sendChatQuestion() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const question = input.value.trim();
  if (!question) return;

  const reportContext = getReportContextText();
  if (!reportContext) {
    appendChatBubble(
      'system',
      'Generate a review first, then ask questions about it.'
    );
    input.value = '';
    return;
  }

  input.value = '';
  appendChatBubble('user', question);
  chatHistory.push({ role: 'user', content: question });

  try {
    const client = await createOllamaClient();
    const transcript = chatHistory
      .slice(-8)
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');
    const prompt =
      `You are an assistant answering questions about a generated code review report.\n` +
      `Use only the report context and conversation below.\n` +
      `If information is missing, explicitly say it is not in the report.\n\n` +
      `REPORT CONTEXT:\n${reportContext}\n\n` +
      `CONVERSATION:\n${transcript}\n\n` +
      `Answer the latest user question clearly and concisely.`;

    appendChatBubble('system', 'Thinking...');
    const messagesEl = document.getElementById('chat-messages');
    const thinkingBubble = messagesEl?.lastElementChild;
    const answer = await askOllama(client, prompt, OLLAMA_TIMEOUT_MS);
    if (thinkingBubble && thinkingBubble.classList.contains('system')) {
      thinkingBubble.remove();
    }
    appendChatBubble('assistant', answer);
    chatHistory.push({ role: 'assistant', content: answer });
  } catch (error) {
    appendChatBubble('system', `Chat error: ${error.message}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendMarkdownProgressive(sectionMarkdown) {
  const tokens = sectionMarkdown.split(/(\s+)/).filter((t) => t.length > 0);
  let buffer = '';
  for (let i = 0; i < tokens.length; i++) {
    buffer += tokens[i];
    const shouldFlush =
      (i + 1) % STREAM_RENDER_EVERY_TOKENS === 0 || i === tokens.length - 1;
    if (!shouldFlush) continue;
    liveMarkdown += buffer;
    buffer = '';
    updateLiveMarkdown();
    await sleep(STREAM_PAUSE_MS);
  }
}

async function reviewPR(diffPath, context, title) {
  inProgress(true);
  setDownloadEnabled(false);
  resetRenderedMarkdown('Fetching PR changes...\n');
  chrome.storage.session.remove([diffPath]);

  try {
    const client = await createOllamaClient();
    const patch = await fetchWithTimeout(diffPath, DIFF_FETCH_TIMEOUT_MS);
    const fileContext = buildFileReviewContext(patch);
    currentReportMeta.files = fileContext.files;
    currentReportMeta.totalAdditions = fileContext.totalAdditions;
    currentReportMeta.totalDeletions = fileContext.totalDeletions;

    let promptArray = [
      `Review the following pull request changes.\n\nTitle: ${title}\n\nChanged files overview:\n${
        fileContext.context
      }\n\nRespond strictly in markdown with this exact structure:\n## Summary\n(2-4 bullet points)\n## Suggestions\n(3-8 bullet points with actionable improvements)\n## Architecture Diagram\n(Visualize the architecture, components, or flow using Mermaid.js syntax inside a \`\`\`mermaid block)\n## File Findings\n(Use bullets grouped by filename where possible)\n## Detailed Review\n(issues, risks, and notable positives)\n\nCode changes:\n${patch.substring(
        0,
        10000
      )}`,
    ];

    resetRenderedMarkdown('Generating review...\n\n');
    const reviewText = await askOllama(
      client,
      promptArray[0],
      OLLAMA_TIMEOUT_MS
    );
    resetRenderedMarkdown('');
    await appendMarkdownProgressive(reviewText);
    commitLiveMarkdown();
    await renderMermaidDiagrams();
    
    chrome.storage.session.set({
      [diffPath]: document.getElementById('result').innerHTML,
    });
    inProgress(false);
    setDownloadEnabled(true);
  } catch (e) {
    resetRenderedMarkdown('Review Error: ' + e.message);
    inProgress(false, true);
    setDownloadEnabled(false);
  }
}

function buildFileReviewContext(patchText) {
  try {
    const files = parseDiff(patchText).map((file) => {
      let additions = 0;
      let deletions = 0;
      for (const chunk of file.chunks || []) {
        for (const change of chunk.changes || []) {
          if (change.type === 'add') additions++;
          if (change.type === 'del') deletions++;
        }
      }
      const path = file.to || file.from || 'unknown-file';
      return { path, additions, deletions };
    });

    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
    const preview = files
      .slice(0, 40)
      .map((f) => `- ${f.path} (+${f.additions} / -${f.deletions})`)
      .join('\n');
    const extra =
      files.length > 40 ? `\n- ...and ${files.length - 40} more files` : '';

    return {
      files,
      totalAdditions,
      totalDeletions,
      context:
        `Files changed: ${files.length}\nTotal additions: ${totalAdditions}\nTotal deletions: ${totalDeletions}\n` +
        (preview || '- No parsed files') +
        extra,
    };
  } catch {
    return {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      context: '- Unable to parse file-level patch details.',
    };
  }
}

function parseGitHubRepoUrl(url) {
  const cleanUrl = (url || '').split('?')[0].split('#')[0];
  const match = cleanUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function isLikelyTextFile(path) {
  const lower = path.toLowerCase();
  if (
    lower.includes('/node_modules/') ||
    lower.includes('/dist/') ||
    lower.includes('/build/') ||
    lower.includes('/coverage/') ||
    lower.includes('/.git/')
  ) {
    return false;
  }
  const binaryExt = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.webp',
    '.ico',
    '.pdf',
    '.zip',
    '.gz',
    '.tar',
    '.7z',
    '.mp4',
    '.mp3',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.exe',
    '.dll',
    '.so',
    '.dylib',
  ];
  return !binaryExt.some((ext) => lower.endsWith(ext));
}

async function fetchJsonWithTimeout(url, timeoutMs, headers = {}) {
  const raw = await fetchWithTimeout(url, timeoutMs, headers);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
}

async function fetchRepositoryContext(owner, repo) {
  const repoMeta = await fetchJsonWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}`,
    DIFF_FETCH_TIMEOUT_MS
  );
  const branch = repoMeta.default_branch;
  if (!branch) {
    throw new Error('Could not determine default branch for repository.');
  }

  const treeData = await fetchJsonWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    DIFF_FETCH_TIMEOUT_MS
  );
  const allFiles = (treeData.tree || []).filter(
    (item) => item.type === 'blob' && isLikelyTextFile(item.path)
  );
  const selectedFiles = allFiles.slice(0, REPO_REVIEW_FILE_LIMIT);
  const skippedFiles = Math.max(0, allFiles.length - selectedFiles.length);

  const files = [];
  let totalChars = 0;
  for (const file of selectedFiles) {
    if (totalChars >= REPO_TOTAL_CHAR_LIMIT) break;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`;
    let content = '';
    try {
      content = await fetchWithTimeout(rawUrl, DIFF_FETCH_TIMEOUT_MS);
    } catch {
      continue;
    }
    if (!content || content.includes('\u0000')) continue;
    const trimmed = content.slice(0, PER_FILE_CHAR_LIMIT);
    totalChars += trimmed.length;
    files.push({
      path: file.path,
      additions: 0,
      deletions: 0,
      chars: trimmed.length,
      content: trimmed,
    });
  }

  return {
    branch,
    files,
    skippedFiles,
    totalChars,
    context:
      `Repository: ${owner}/${repo}\n` +
      `Default branch: ${branch}\n` +
      `Text files detected: ${allFiles.length}\n` +
      `Files included in analysis: ${files.length}\n` +
      `Files skipped due to limit: ${skippedFiles}\n` +
      `Total characters sent: ${totalChars}`,
  };
}

async function reviewRepository(owner, repo) {
  inProgress(true);
  setDownloadEnabled(false);
  resetRenderedMarkdown('Fetching repository files...\n');

  try {
    const client = await createOllamaClient();
    const repoContext = await fetchRepositoryContext(owner, repo);
    currentReportMeta.mode = 'repo';
    currentReportMeta.branch = repoContext.branch;
    currentReportMeta.files = repoContext.files.map((f) => ({
      path: f.path,
      additions: 0,
      deletions: 0,
    }));
    currentReportMeta.totalAdditions = 0;
    currentReportMeta.totalDeletions = 0;
    currentReportMeta.skippedFiles = repoContext.skippedFiles;

    resetRenderedMarkdown(
      `# Repository Review\n\n` +
        `Repository: ${owner}/${repo}\n\n` +
        `Branch: ${repoContext.branch}\n\n` +
        `Files selected: ${repoContext.files.length}\n\n` +
        `Starting file-by-file analysis...\n\n`
    );

    const perFileFindings = [];
    for (let i = 0; i < repoContext.files.length; i++) {
      const file = repoContext.files[i];
      appendStaticMarkdown(
        `\n\n---\n\n## Progress\nAnalyzing file ${i + 1}/${
          repoContext.files.length
        }: \`${file.path}\`\n\n`
      );

      const filePrompt =
        `Analyze this single repository file for bugs, reliability issues, and maintainability concerns.\n` +
        `Return markdown with this exact structure:\n` +
        `### ${file.path}\n` +
        `- Risk: low|medium|high\n` +
        `- Issues: bullet list\n` +
        `- Suggested Fixes: bullet list\n` +
        `- Quick Summary: one short bullet\n\n` +
        `File content:\n` +
        '```text\n' +
        `${file.content}\n` +
        '```';

      try {
        const fileResult = await askOllama(
          client,
          filePrompt,
          OLLAMA_TIMEOUT_MS
        );
        perFileFindings.push(`FILE: ${file.path}\n${fileResult}`);
        await appendMarkdownProgressive(`${fileResult}\n`);
        commitLiveMarkdown();
      } catch (fileError) {
        const errText = `### ${file.path}\n- Risk: unknown\n- Issues: Could not analyze file due to: ${fileError.message}\n- Suggested Fixes: Retry analysis for this file.\n- Quick Summary: Analysis failed for this file.\n`;
        perFileFindings.push(`FILE: ${file.path}\n${errText}`);
        await appendMarkdownProgressive(`${errText}\n`);
        commitLiveMarkdown();
      }
    }

    appendStaticMarkdown(
      '\n\n---\n\n## Finalizing\nGenerating overall summary...\n\n'
    );
    const summaryPrompt =
      `You are given file-by-file findings from a repository review.\n` +
      `Create a final markdown report with sections exactly:\n` +
      `## Summary\n## Suggestions\n## Architecture Diagram\n(Visualize the code architecture, components, or flow using Mermaid.js syntax inside a \`\`\`mermaid block)\n## File Findings\n## Potential Bugs\n## Next Steps\n\n` +
      `Repository: ${owner}/${repo}\nBranch: ${repoContext.branch}\n` +
      `Files analyzed: ${repoContext.files.length}\n` +
      `Files skipped due to limit/filter: ${repoContext.skippedFiles}\n\n` +
      `Findings:\n${perFileFindings.join('\n\n').slice(0, 70000)}`;

    const finalSummary = await askOllama(
      client,
      summaryPrompt,
      OLLAMA_TIMEOUT_MS
    );
    await appendMarkdownProgressive(`\n\n---\n\n${finalSummary}\n`);
    commitLiveMarkdown();
    await renderMermaidDiagrams();

    chrome.storage.session.set({
      [`repo:${currentReportMeta.url}`]:
        document.getElementById('result').innerHTML,
    });
    inProgress(false);
    setDownloadEnabled(true);
  } catch (e) {
    resetRenderedMarkdown('Review Error: ' + e.message);
    inProgress(false, true);
    setDownloadEnabled(false);
  }
}

async function fetchWithTimeout(url, timeoutMs, headers = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${url}.`);
    }
    return await response.text();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(
        `Timed out after ${timeoutMs / 1000}s while fetching ${url}.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function toChatCompletionsUrl(baseUrl) {
  const normalized = (baseUrl || '').replace(/\/+$/, '');
  if (normalized.endsWith('/v1')) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
}

async function postJsonWithTimeout(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const shouldTimeout = Number.isFinite(timeoutMs) && Number(timeoutMs) > 0;
  const timeoutId = shouldTimeout
    ? setTimeout(() => controller.abort(), Number(timeoutMs))
    : null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      const detail = parsed?.error?.message || raw || `HTTP ${response.status}`;
      throw new Error(`Ollama request failed: ${detail}`);
    }
    return parsed;
  } catch (error) {
    if (error.name === 'AbortError' && shouldTimeout) {
      throw new Error(
        `Timed out after ${
          Number(timeoutMs) / 1000
        }s waiting for Ollama response.`
      );
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

const spinner =
  '<svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
const checkmark =
  '<svg class="h-4 w-4 text-green-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>';
const xcircle =
  '<svg class="h-4 w-4 text-red-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>';

function run(forceRefresh = false) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs[0]) return;
    const url = (tabs[0].url || '').split('?')[0].split('#')[0];
    const title = tabs[0].title;
    const repoUrlParts = parseGitHubRepoUrl(url);
    currentReportMeta = {
      mode: repoUrlParts ? 'repo' : 'pr',
      title:
        title ||
        (repoUrlParts ? `${repoUrlParts.owner}/${repoUrlParts.repo}` : ''),
      url,
      branch: '',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      skippedFiles: 0,
    };
    const isGitHubPR = url.match(
      /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
    );

    const prUrlEl = document.getElementById('pr-url');
    if (prUrlEl) prUrlEl.innerText = url;

    if (isGitHubPR) {
      const diffPath = url + '.patch';
      if (forceRefresh) {
        chrome.storage.session.remove([diffPath], () => {
          reviewPR(diffPath, isGitHubPR, title);
        });
        return;
      }
      chrome.storage.session.get([diffPath], (result) => {
        if (result[diffPath]) {
          document.getElementById('result').innerHTML = result[diffPath];
          inProgress(false);
          setDownloadEnabled(true);
        } else {
          reviewPR(diffPath, isGitHubPR, title);
        }
      });
    } else if (repoUrlParts) {
      const repoCacheKey = `repo:${url}`;
      if (forceRefresh) {
        chrome.storage.session.remove([repoCacheKey], () => {
          reviewRepository(repoUrlParts.owner, repoUrlParts.repo);
        });
        return;
      }
      chrome.storage.session.get([repoCacheKey], (result) => {
        if (result[repoCacheKey]) {
          document.getElementById('result').innerHTML = result[repoCacheKey];
          inProgress(false);
          setDownloadEnabled(true);
        } else {
          reviewRepository(repoUrlParts.owner, repoUrlParts.repo);
        }
      });
    } else {
      inProgress(false, true);
      setDownloadEnabled(false);
      document.getElementById('result').innerHTML =
        '<div class="p-4 text-orange-600">Please navigate to a GitHub Pull Request or repository root page to use this extension.</div>';
    }
  });
}

function downloadReportPdf() {
  const resultEl = document.getElementById('result');
  if (!resultEl || !resultEl.innerText.trim()) return;

  const now = new Date();
  const lines = [
    'Compact Review Report',
    '',
    `Mode: ${
      currentReportMeta.mode === 'repo'
        ? 'Repository Review'
        : 'Pull Request Review'
    }`,
    `Title: ${currentReportMeta.title || 'N/A'}`,
    `URL: ${currentReportMeta.url || 'N/A'}`,
    ...(currentReportMeta.branch
      ? [`Branch: ${currentReportMeta.branch}`]
      : []),
    `Generated: ${now.toISOString()}`,
    '',
    `Files changed: ${currentReportMeta.files.length}`,
    `Total additions: ${currentReportMeta.totalAdditions}`,
    `Total deletions: ${currentReportMeta.totalDeletions}`,
    ...(currentReportMeta.mode === 'repo'
      ? [`Files skipped (limit/filter): ${currentReportMeta.skippedFiles}`]
      : []),
    '',
    '----- FILES -----',
    ...(currentReportMeta.files.length
      ? currentReportMeta.files.map(
          (f) => `${f.path} (+${f.additions} / -${f.deletions})`
        )
      : ['No file stats available']),
    '',
    '----- REVIEW -----',
    '',
    ...resultEl.innerText.split('\n'),
  ];

  const wrappedLines = wrapLines(lines, 95);
  const pdfBytes = createPdfFromLines(wrappedLines);
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const downloadUrl = URL.createObjectURL(blob);

  const a = document.createElement('a');
  const safeName = sanitizeFileName(
    currentReportMeta.title || 'compact-review-report'
  );
  a.href = downloadUrl;
  a.download = `${safeName}-${now.getTime()}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(downloadUrl);
}

function sanitizeFileName(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

function wrapLines(lines, maxChars) {
  const wrapped = [];
  for (const line of lines) {
    if (!line) {
      wrapped.push('');
      continue;
    }
    let remaining = line;
    while (remaining.length > maxChars) {
      const splitAt = remaining.lastIndexOf(' ', maxChars);
      const index = splitAt > 0 ? splitAt : maxChars;
      wrapped.push(remaining.slice(0, index));
      remaining = remaining.slice(index).trimStart();
    }
    wrapped.push(remaining);
  }
  return wrapped;
}

function escapePdfText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function createPdfFromLines(lines) {
  const linesPerPage = 52;
  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }

  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');

  const pageObjectIds = [];
  const contentObjectIds = [];
  let nextId = 3;
  for (let i = 0; i < pages.length; i++) {
    pageObjectIds.push(nextId++);
    contentObjectIds.push(nextId++);
  }
  const fontObjectId = nextId++;

  objects.push(
    `<< /Type /Pages /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(' ')}] /Count ${pageObjectIds.length} >>`
  );

  for (let i = 0; i < pages.length; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectIds[i]} 0 R >>`
    );

    const body = [
      'BT',
      '/F1 10 Tf',
      '14 TL',
      '50 760 Td',
      ...pages[i].map((line) => `(${escapePdfText(line)}) Tj T*`),
      'ET',
    ].join('\n');
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  }

  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

const runButton = document.getElementById('rerun-btn');
if (runButton) {
  runButton.addEventListener('click', () => run(true));
}
const downloadButton = document.getElementById('download-btn');
if (downloadButton) {
  downloadButton.addEventListener('click', downloadReportPdf);
}
const chatToggleBtn = document.getElementById('chat-toggle-btn');
if (chatToggleBtn) {
  chatToggleBtn.addEventListener('click', toggleChatPanel);
}
const chatSendBtn = document.getElementById('chat-send');
if (chatSendBtn) {
  chatSendBtn.addEventListener('click', sendChatQuestion);
}
const chatInput = document.getElementById('chat-input');
if (chatInput) {
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendChatQuestion();
    }
  });
}
run();
