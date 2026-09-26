(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GeminiFormat = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatWhen(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  function formatClock(totalSeconds) {
    const seconds = Math.max(0, totalSeconds | 0);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return minutes + ':' + String(rest).padStart(2, '0');
  }

  function inline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_match, label, href) => {
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    return html;
  }

  function isStructural(line) {
    const trimmed = line.trim();
    return (
      /^#{1,3}\s+/.test(trimmed)
      || /^>\s?/.test(trimmed)
      || /^[-*]\s+/.test(trimmed)
      || /^\d+\.\s+/.test(trimmed)
      || /^-{3,}$/.test(trimmed)
      || /^\u0000F\d+\u0000$/.test(trimmed)
    );
  }

  function renderMarkdown(src) {
    const input = String(src ?? '').replace(/\u0000/g, '').replace(/\r\n/g, '\n');
    const fences = [];
    const fenced = input.replace(/```[^\n`]*\n([\s\S]*?)```/g, (_match, code) => {
      const html = '<pre class="codeblock"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre>';
      const token = '\u0000F' + fences.length + '\u0000';
      fences.push(html);
      return '\n' + token + '\n';
    });

    const lines = fenced.split('\n');
    const out = [];
    let index = 0;
    while (index < lines.length) {
      const trimmed = lines[index].trim();
      const fence = trimmed.match(/^\u0000F(\d+)\u0000$/);
      if (fence) {
        out.push(fences[Number(fence[1])]);
        index += 1;
        continue;
      }
      if (!trimmed) {
        index += 1;
        continue;
      }
      const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push('<h' + level + '>' + inline(heading[2]) + '</h' + level + '>');
        index += 1;
        continue;
      }
      if (/^-{3,}$/.test(trimmed)) {
        out.push('<hr>');
        index += 1;
        continue;
      }
      if (/^>\s?/.test(trimmed)) {
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
          quote.push(inline(lines[index].trim().replace(/^>\s?/, '')));
          index += 1;
        }
        out.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
        continue;
      }
      if (/^[-*]\s+/.test(trimmed)) {
        const items = [];
        while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
          items.push('<li>' + inline(lines[index].trim().replace(/^[-*]\s+/, '')) + '</li>');
          index += 1;
        }
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\d+\.\s+/.test(trimmed)) {
        const items = [];
        while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
          items.push('<li>' + inline(lines[index].trim().replace(/^\d+\.\s+/, '')) + '</li>');
          index += 1;
        }
        out.push('<ol>' + items.join('') + '</ol>');
        continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !isStructural(lines[index])) {
        paragraph.push(inline(lines[index]));
        index += 1;
      }
      out.push('<p>' + paragraph.join('<br>') + '</p>');
    }
    return out.join('');
  }

  return {
    escapeHtml,
    renderMarkdown,
    formatWhen,
    formatClock,
  };
}));
