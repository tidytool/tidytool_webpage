"use client";

/**
 * Minimal modal built on the native <dialog> element — no dependency, no portal
 * library (keeps the portal within its "reach for one well-justified library,
 * not a pile" rule). Renders a trigger button; clicking it calls showModal(),
 * which gives focus-trapping and Esc-to-close for free. The ✕ and a backdrop
 * click both close it. Children are the modal body — server-action forms work
 * inside a client component's <form action={...}> as usual.
 */
import { useRef, type ReactNode } from "react";

export function Modal({
  label,
  title,
  children,
  triggerClassName = "btn btn--ghost",
  wide = false,
}: {
  label: ReactNode;
  title: string;
  children: ReactNode;
  triggerClassName?: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = () => ref.current?.close();

  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => ref.current?.showModal()}>
        {label}
      </button>
      <dialog
        ref={ref}
        className="modal"
        onClick={(e) => {
          // A click whose target is the <dialog> itself is the ::backdrop.
          if (e.target === ref.current) close();
        }}
      >
        <div className={wide ? "modal__panel modal__panel--wide" : "modal__panel"}>
          <div className="modal__head">
            <h2 style={{ margin: 0 }}>{title}</h2>
            <button type="button" className="modal__x" aria-label="Close" onClick={close}>
              ✕
            </button>
          </div>
          <div className="modal__body">{children}</div>
        </div>
      </dialog>
    </>
  );
}
