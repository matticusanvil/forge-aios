import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Claude's replies as markdown. react-markdown renders no raw HTML, so nothing in a reply can inject markup.
export function Markdown({ text }: { text: string }) {
  return (
    <div className="cockpit-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
