/** Text only: a paragraph beginning with ## becomes a subheading. Never render markup. */
export function EditorialText({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h1>{title}</h1>
      {body.split(/\n\s*\n/).map((part, i) =>
        part.startsWith('## ') ? (
          <h2 key={i}>{part.slice(3)}</h2>
        ) : (
          <p key={i} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {part}
          </p>
        ),
      )}
    </>
  );
}
