import { parseSessionTags, SESSION_TAG_LENGTH_LIMIT, SESSION_TAG_LIMIT } from '../archive';
import { button, el, icons } from './shared';

function normalize(text: string): string | undefined
{
  return parseSessionTags([text.slice(0, SESSION_TAG_LENGTH_LIMIT)])[0];
}

export function createTagEditor(initial: readonly string[], change: (tags: string[]) => void)
{
  const element = el('div', 'tag-editor');
  const input = el('input', 'tag-editor-input');
  input.type = 'text';
  input.autocomplete = 'off';
  element.append(input);
  let tags = [...initial];
  let disabled = false;

  function render(): void
  {
    // keep the input in place so typing and focus survive tag changes
    for (const chip of element.querySelectorAll('.tag-editor-chip')) chip.remove();
    input.before(...tags.map(tag => {
      const chip = el('span', 'tag-editor-chip', tag);
      const remove = button('', icons.X, 'tag-editor-remove');
      remove.setAttribute('aria-label', `Remove tag ${tag}`);
      remove.disabled = disabled;
      remove.addEventListener('click', () => {
        tags = tags.filter(value => value !== tag);
        render();
        change([...tags]);
        input.focus();
      });
      chip.append(remove);
      return chip;
    }));
    // drop unfinished text at the limit so the disabled input cannot hold an extra tag
    if (tags.length >= SESSION_TAG_LIMIT) input.value = '';
    input.disabled = disabled || tags.length >= SESSION_TAG_LIMIT;
  }

  function add(text: string): void
  {
    const tag = normalize(text);
    if (!tag || tags.includes(tag) || tags.length >= SESSION_TAG_LIMIT) return;
    tags.push(tag);
    render();
    change([...tags]);
  }

  input.addEventListener('input', () => {
    // create a tag at each comma or space and keep the unfinished text
    const parts = input.value.split(/[,\s]+/);
    if (parts.length < 2) return;
    input.value = parts.pop() ?? '';
    for (const part of parts) add(part);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && input.value.trim()) {
      event.preventDefault();
      add(input.value);
      input.value = '';
    } else if (event.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      render();
      change([...tags]);
    }
  });
  element.addEventListener('click', event => { if (event.target === element) input.focus(); });
  render();

  return {
    element,
    input,
    // include text that has not become a tag yet
    tags(): string[]
    {
      const pending = normalize(input.value);
      return pending && !tags.includes(pending) ? [...tags, pending] : [...tags];
    },
    setDisabled(value: boolean): void
    {
      disabled = value;
      render();
    },
  };
}
