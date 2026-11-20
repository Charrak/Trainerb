import Link from 'next/link';
/** Text content: a paragraph beginning with ## becomes a subheading. Never render markup. */
export type Presentation = {
  banner?: string | null;
  button_path?: string | null;
  button_label?: string | null;
  image_alt?: string | null;
  image_url?: string | null;
};
export function EditorialText({
  title,
  body,
  banner,
  button_path,
  button_label,
  image_url,
  image_alt,
  preview = false,
}: { title: string; body: string; preview?: boolean } & Presentation) {
  return (
    <>
      <h1>{title}</h1>
      {banner && <p className="page-banner">{banner}</p>}
      {image_url && <img className="page-image" src={image_url} alt={image_alt || ''} />}
      {body.split(/\n\s*\n/).map((part, i) =>
        part.startsWith('## ') ? (
          <h2 key={i}>{part.slice(3)}</h2>
        ) : (
          <p key={i} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {part}
          </p>
        ),
      )}
      {button_label &&
        button_path &&
        (preview ? (
          <span className="button button-primary">{button_label}</span>
        ) : (
          <Link className="button button-primary" href={button_path}>
            {button_label}
          </Link>
        ))}
    </>
  );
}
