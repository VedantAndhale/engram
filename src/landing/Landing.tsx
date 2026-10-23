import "./landing.css";
import { APP_BASE } from "../lib/base";

const REPO = "https://github.com/VedantAndhale/engram";
const TODAY = `${APP_BASE}/today`;

/**
 * The page a first-time visitor sees at the site's root, before they have any folder. It states
 * what Engram does, what leaves the device (nothing, except what the README names), and what it
 * costs. It makes no claims about users or reviews that do not exist.
 */
export function Landing({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="landing-brand" href="#top" aria-label="Engram home">
          Engram
        </a>
        <nav aria-label="Page">
          <a href="#how">How it works</a>
          <a href="#privacy">Privacy</a>
          <a href="#faq">FAQ</a>
          <a href={REPO}>GitHub</a>
        </nav>
        <a className="landing-button small" href={TODAY} onClick={(e) => (e.preventDefault(), onOpen())}>
          Open Engram
        </a>
      </header>

      <main id="top">
        <section className="landing-hero">
          <p className="landing-eyebrow">Free and open source · AGPL-3.0</p>
          <h1>The reader that keeps your library in your own GitHub account.</h1>
          <p className="landing-lede">
            Save articles, PDFs and links. Highlight what matters. Ask a small AI model about any passage, running in
            your browser, and keep the answer as a Markdown note you own.
          </p>
          <div className="landing-actions">
            <a className="landing-button" href={TODAY} onClick={(e) => (e.preventDefault(), onOpen())}>
              Open Engram, no account needed
            </a>
            <a className="landing-link" href={REPO}>
              Read the source
            </a>
          </div>
          <p className="landing-fine">Nothing to install. Reading and saving work without signing in.</p>
          <img
            className="landing-demo"
            src={`${APP_BASE}/engram-demo.gif`}
            alt="Engram: the library with a sample article, and the Save button and 'Press N to save a quote' hint"
          />
        </section>

        <section id="how" className="landing-section">
          <h2>How it works</h2>
          <ol className="landing-steps">
            <li>
              <h3>Save</h3>
              <p>
                Paste a link, or on Android share it straight to Engram. On iPhone, copy the link and paste it under
                Save. Engram keeps the article's text, not just the link.
              </p>
            </li>
            <li>
              <h3>Read and highlight</h3>
              <p>Mark passages as you read. Select a passage to ask a question, and the answer appears beside the text.</p>
            </li>
            <li>
              <h3>Keep</h3>
              <p>
                Each folder syncs to a private GitHub repository in your account, as plain Markdown files you can open
                anywhere.
              </p>
            </li>
          </ol>
        </section>

        <section className="landing-section landing-split">
          <div>
            <h2>Reads with you, on your device</h2>
            <p>
              Select a passage and ask for an explanation, a definition, a simpler version, or the counterpoint. A
              small model, Gemma 4 E2B, answers in a note beside the text. It runs in your browser with WebGPU.
            </p>
            <p>
              The first answer downloads the model once, about 2 GB from Hugging Face. Your questions and the passages
              they cover stay on your device. Every answer shows the passage it was given, so you can check it. It can
              still be wrong.
            </p>
          </div>
          <div>
            <h2>Your library is yours</h2>
            <p>
              Notes, highlights and saved text are Markdown files in a private GitHub repository in your account.
              Engram's server does not store your library.
            </p>
            <p>
              If Engram disappeared tomorrow, your files would still be in your repository and readable without it.
            </p>
          </div>
        </section>

        <section id="privacy" className="landing-section">
          <h2>Where your data goes</h2>
          <table className="landing-table">
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Where it goes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Articles and PDFs you read</td>
                <td>Stay in your browser.</td>
              </tr>
              <tr>
                <td>Highlights and notes</td>
                <td>Your private GitHub repository, once you turn on sync.</td>
              </tr>
              <tr>
                <td>Questions about a passage</td>
                <td>Answered by the model on your device. No AI service receives them.</td>
              </tr>
              <tr>
                <td>A link saved without its text</td>
                <td>Engram's server fetches the page once and keeps nothing. Only the address is sent.</td>
              </tr>
              <tr>
                <td>Page views on this website</td>
                <td>Counted with GoatCounter as screen names only, never your titles or text.</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="landing-section">
          <h2>Works with the AI agent you already use</h2>
          <p className="landing-narrow">
            Engram has a hosted MCP server. Connect an MCP client and it can search your library, read your highlights,
            quiz you on what is due, and suggest things to save. Every suggestion waits for you to accept or dismiss it.
          </p>
        </section>

        <section id="faq" className="landing-section">
          <h2>Questions</h2>
          <div className="landing-faq">
            <details>
              <summary>Do I need an account?</summary>
              <p>No. Reading, saving and search work without one. Sync and agent access need a GitHub sign-in.</p>
            </details>
            <details>
              <summary>Is it free?</summary>
              <p>
                Yes. Engram is open source under AGPL-3.0. You can use it, change it, and host it yourself. The README
                explains how.
              </p>
            </details>
            <details>
              <summary>Which browsers work?</summary>
              <p>
                Any recent browser can read and save. The on-device model needs WebGPU: a recent Chrome or Edge on a
                computer with a graphics card.
              </p>
            </details>
            <details>
              <summary>Does my reading leave my device?</summary>
              <p>
                Your reading stays on your device or in your GitHub repository. One exception: a link saved without its
                text is fetched through Engram's server, which keeps nothing.
              </p>
            </details>
            <details>
              <summary>What if Engram shuts down?</summary>
              <p>Your library is Markdown in your GitHub repositories. Nothing needs Engram to read it.</p>
            </details>
          </div>
        </section>

        <section className="landing-final">
          <h2>Start with one article.</h2>
          <div className="landing-actions">
            <a className="landing-button" href={TODAY} onClick={(e) => (e.preventDefault(), onOpen())}>
              Open Engram
            </a>
            <a className="landing-link" href={REPO}>
              View the source on GitHub
            </a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span>Engram · AGPL-3.0</span>
        <nav aria-label="Footer">
          <a href={REPO}>GitHub</a>
          <a href={`${REPO}/blob/main/README.md`}>README</a>
          <a href={`${REPO}/blob/main/LICENSE`}>License</a>
        </nav>
      </footer>
    </div>
  );
}
