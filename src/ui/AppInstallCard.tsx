import { useEffect, useState } from "react";
import { getAccount } from "../sync/account";
import { GitHub } from "../sync/github";
import { INSTALL_URL, pickInstallation, type Installation } from "../sync/install";

type State = "checking" | "installed" | "missing" | "error";

// Setup step for App sign-ins: Engram can only reach folder repos once the App is installed.
// OAuth sign-ins don't need it, so the card renders nothing for them.
export function AppInstallCard() {
  const account = getAccount();
  // Only App sign-ins carry a refresh token, so that is how the two modes are told apart.
  const token = account?.refresh ? account.token : undefined;
  const [state, setState] = useState<State>("checking");
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let live = true;
    const check = () => {
      if (!token) return;
      new GitHub(token)
        .json<{ installations: Installation[] }>("/user/installations")
        .then((res) => {
          if (live) setState(pickInstallation(res.installations ?? []) ? "installed" : "missing");
        })
        .catch((e: unknown) => {
          // Show the problem in the card instead of throwing, so Setup keeps working.
          if (!live) return;
          setProblem(e instanceof Error ? e.message : "Couldn't check the Engram Reader install.");
          setState("error");
        });
    };
    check();
    // Coming back from the GitHub install tab should update the card without a reload.
    window.addEventListener("focus", check);
    return () => {
      live = false;
      window.removeEventListener("focus", check);
    };
  }, [token]);

  if (!token) return null;

  return (
    <section className="setup-card">
      {state === "checking" && <p className="muted">Checking the Engram Reader install...</p>}
      {state === "installed" && <p>Engram Reader is installed on your account.</p>}
      {state === "missing" && (
        <>
          <p>Install Engram Reader and choose repositories, so Engram can reach your folders.</p>
          <a className="btn btn-primary" href={INSTALL_URL} target="_blank" rel="noreferrer">
            Install Engram Reader
          </a>
        </>
      )}
      {state === "error" && <p className="muted">{problem}</p>}
    </section>
  );
}