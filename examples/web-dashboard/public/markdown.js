import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

export function markdownContent(text, citations = new Map()) {
	const fragment = DOMPurify.sanitize(marked.parse(text, { async: false, breaks: false }), {
		RETURN_DOM_FRAGMENT: true,
		ALLOWED_TAGS: ['p', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'em', 'blockquote', 'h3', 'h4', 'a', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
		ALLOWED_ATTR: ['href', 'title'],
	});
	for (const link of fragment.querySelectorAll('a')) {
		try {
			const url = new URL(link.getAttribute('href'), location.href);
			if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { link.removeAttribute('href'); continue; }
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
		} catch { link.removeAttribute('href'); }
	}
	const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
	const nodes = [];
	while (walker.nextNode()) { nodes.push(walker.currentNode); }
	for (const node of nodes) {
		if (node.parentElement?.closest('pre, code, a')) { continue; }
		const matches = [...node.textContent.matchAll(/\[((?:S[1-9][0-9]*|A1))\]/g)];
		if (matches.length === 0) { continue; }
		const replacement = document.createDocumentFragment();
		let offset = 0;
		for (const match of matches) {
			replacement.append(document.createTextNode(node.textContent.slice(offset, match.index)));
			const target = citations.get(match[1]);
			if (target === undefined) { replacement.append(document.createTextNode(match[0])); }
			else {
				const link = document.createElement('a');
				link.className = 'citation-link';
				link.href = `#${target.id}`;
				link.textContent = match[0];
				link.title = `Open evidence ${match[1]}`;
				link.addEventListener('click', (event) => {
					event.preventDefault();
					for (let parent = target; parent !== null; parent = parent.parentElement) { if (parent.tagName === 'DETAILS') { parent.open = true; } }
					target.scrollIntoView({ block: 'nearest', behavior: 'auto' });
					target.querySelector('summary')?.focus({ preventScroll: true });
				});
				replacement.append(link);
			}
			offset = match.index + match[0].length;
		}
		replacement.append(document.createTextNode(node.textContent.slice(offset)));
		node.replaceWith(replacement);
	}
	return fragment;
}
