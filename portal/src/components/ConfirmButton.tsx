"use client";

/**
 * Submit button gated behind a native confirm dialog. For irreversible
 * actions, pass requireText to force typing a word (e.g. "DELETE") first.
 */
export function ConfirmButton({
  children,
  message,
  requireText,
  className = "btn btn--danger",
}: {
  children: React.ReactNode;
  message: string;
  requireText?: string;
  className?: string;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (requireText) {
          const typed = window.prompt(`${message}\n\nType ${requireText} to confirm:`);
          if (typed !== requireText) e.preventDefault();
        } else if (!window.confirm(message)) {
          e.preventDefault();
        }
      }}
    >
      {children}
    </button>
  );
}
