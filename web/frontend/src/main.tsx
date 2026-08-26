import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { BuildStamp } from "./BuildStamp.tsx";
import { HarnessPage } from "./HarnessPage";
import "./App.css";

const params = new URLSearchParams(window.location.search);
const harnessJob = params.get("harnessJob") || params.get("harness_job");
const playback = params.get("playback") || "";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {harnessJob ? <HarnessPage jobId={harnessJob} playback={playback} /> : <App />}
    <BuildStamp />
  </StrictMode>,
);
