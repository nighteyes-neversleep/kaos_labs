import { useLayoutEffect, useRef, type ReactNode } from 'react';

type Props = {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  describedBy?: string;
  initialFocusSelector?: string;
};

/** Native modal semantics make the page inert and keep Tab within the dialog. */
export default function AccessibleDialog({ title, children, onClose, className = 'modal', describedBy, initialFocusSelector }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const initialSelectorRef = useRef(initialFocusSelector);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    const target = initialSelectorRef.current
      ? dialog.querySelector<HTMLElement>(initialSelectorRef.current)
      : dialog.querySelector<HTMLElement>('[autofocus], [data-dialog-initial-focus]')
        ?? dialog.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
        ?? dialog.querySelector<HTMLElement>('button:not([disabled])');
    target?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      // A consent dialog can be replaced by a cartridge dialog in one commit.
      // Do not steal focus from the newly opened dialog during that transition.
      requestAnimationFrame(() => {
        if (document.querySelector('dialog[open]')) return;
        // A keyboard action may already have deliberately moved focus after the
        // dialog closed. Preserve it instead of stealing focus a frame later.
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body && active.isConnected) return;
        const opener = openerRef.current;
        if (opener?.isConnected && !opener.closest('[inert]') && opener.getClientRects().length) {
          opener.focus({ preventScroll: true });
        } else {
          const fallback = document.querySelector<HTMLElement>('main h1, main');
          if (fallback) { fallback.tabIndex = -1; fallback.focus({ preventScroll: true }); }
        }
      });
    };
  }, []);

  return <dialog ref={dialogRef} className={className} aria-label={title} aria-describedby={describedBy}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const dialog = event.currentTarget;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex="0"]')).filter(item => item.getClientRects().length > 0 && !item.closest('[inert]'));
      const first = items[0], last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onClick={event => {
      // The dialog element also receives clicks in blank content; close only
      // when the pointer is actually outside its bounding rectangle.
      if (event.target !== event.currentTarget) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    {children}
  </dialog>;
}
