import type { ReactNode } from 'react';

export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  let safe = false;
  try {
    const url = new URL(href);
    safe = url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    /* Untrusted upstream links render as ordinary text. */
  }
  return safe ? (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span className={className}>{children}</span>
  );
}
