const api = (window as any).xBrowser;
const conversation = document.querySelector("#conversation")!;
const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
const pending = new Map<string, HTMLElement>();

send.addEventListener("click", submit);
api.chat.onEvent(handleChatEvent);
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submit();
  }
});

async function submit() {
  const text = prompt.value.trim();
  if (!text) return;
  prompt.value = "";
  append("user", text);
  try {
    const result = await api.chat.send(text);
    const article = append("assistant", "");
    article.classList.add("streaming");
    pending.set(result.messageId, article);
  } catch (error: any) {
    append("assistant", `无法启动 Browser Agent：${error?.message || error}`);
  }
}

function append(role: "user" | "assistant", text: string) {
  const article = document.createElement("article");
  article.className = `message ${role}`;
  article.innerHTML = `<div class="message-label">${role === "user" ? "你" : "UFO-Browser"}</div><p></p>`;
  article.querySelector("p")!.textContent = text;
  conversation.append(article);
  conversation.scrollTop = conversation.scrollHeight;
  return article;
}

function handleChatEvent(event: any) {
  const article = pending.get(event.messageId);
  if (!article) return;
  if (event.type === "delta") {
    article.querySelector("p")!.textContent += event.text;
  } else if (event.type === "tool") {
    const tool = document.createElement("div");
    tool.className = "tool-row";
    tool.innerHTML = `<span>↗</span><div><strong></strong><small>通过受管能力执行</small></div><em>运行中</em>`;
    tool.querySelector("strong")!.textContent = event.name;
    article.append(tool);
  } else if (event.type === "done") {
    article.classList.remove("streaming");
    pending.delete(event.messageId);
  } else if (event.type === "error") {
    article.classList.remove("streaming");
    article.querySelector("p")!.textContent += `\n${event.error}`;
    pending.delete(event.messageId);
  }
  conversation.scrollTop = conversation.scrollHeight;
}
