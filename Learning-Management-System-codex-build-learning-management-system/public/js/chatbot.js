(() => {
  const launcher = document.getElementById('chatbot-launcher');
  const panel = document.getElementById('chatbot-panel');
  const closeBtn = document.getElementById('chatbot-close');
  const form = document.getElementById('chatbot-form');
  const input = document.getElementById('chatbot-input');
  const body = document.getElementById('chatbot-body');

  if (!launcher || !panel || !form || !input || !body) return;

  function appendMessage(text, role, links = []) {
    const wrapper = document.createElement('div');
    wrapper.className = `chatbot-message ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'chatbot-bubble';
    bubble.textContent = text;
    wrapper.appendChild(bubble);

    if (links.length) {
      const linksWrap = document.createElement('div');
      linksWrap.className = 'chatbot-links';
      links.forEach((link) => {
        const a = document.createElement('a');
        a.href = link.url;
        a.textContent = link.label;
        a.className = 'chatbot-link';
        linksWrap.appendChild(a);
      });
      wrapper.appendChild(linksWrap);
    }

    body.appendChild(wrapper);
    body.scrollTop = body.scrollHeight;
  }

  async function sendMessage(text) {
    appendMessage(text, 'user');
    const response = await fetch('/chatbot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ message: text })
    });
    const data = await response.json();
    appendMessage(data.message, 'bot', data.links || []);
  }

  launcher.addEventListener('click', () => {
    panel.classList.add('open');
    launcher.setAttribute('aria-expanded', 'true');
    input.focus();
  });

  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    launcher.setAttribute('aria-expanded', 'false');
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendMessage(text).catch(() => {
      appendMessage('Sorry, I could not reach the help service. Please try again.', 'bot');
    });
  });

  appendMessage('Hello! Ask me where to find courses, grades, transcripts, payments, or resources.', 'bot');
})();
