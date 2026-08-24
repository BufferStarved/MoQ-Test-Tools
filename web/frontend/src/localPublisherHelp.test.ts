import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isLocalDevApi,
  isPublicOrchestrator,
  laptopLastMileAllowed,
  localPublisherAgentCommand,
  localPublisherAgentOneLiner,
} from "./localPublisherHelp.ts";

describe("local publisher help never shares an operator camera", () => {
  it("treats the public site as a public orchestrator", () => {
    assert.equal(isPublicOrchestrator("https://moq.sean-mccarthy.net"), true);
    assert.equal(isLocalDevApi("https://moq.sean-mccarthy.net"), false);
    assert.equal(laptopLastMileAllowed("https://moq.sean-mccarthy.net"), false);
    assert.equal(laptopLastMileAllowed("http://127.0.0.1:5173"), true);
  });

  it("emits no copy-paste command for the public site without a session", () => {
    assert.equal(localPublisherAgentCommand("https://moq.sean-mccarthy.net"), "");
    assert.equal(localPublisherAgentOneLiner("https://moq.sean-mccarthy.net"), "");
  });

  it("binds the public helper command to this browser session", () => {
    const cmd = localPublisherAgentOneLiner(
      "https://moq.sean-mccarthy.net",
      "dev-local-publisher",
      "sess-visitor-1",
    );
    assert.match(cmd, /LOCAL_PUBLISHER_API=https:\/\/moq\.sean-mccarthy\.net/);
    assert.match(cmd, /LOCAL_PUBLISHER_SESSION=sess-visitor-1/);
    assert.match(cmd, /bash -c /);
    assert.match(cmd, /HOME\/Developer\/moq-test-tools/);
    assert.match(cmd, /run-local-publisher\.sh/);
    assert.doesNotMatch(cmd, /LOCAL_PUBLISHER_TOKEN=/);
    assert.doesNotMatch(cmd, /(?:^|\s)\.\/scripts\/run-local-publisher\.sh/);
  });

  it("keeps the localhost one-liner", () => {
    const cmd = localPublisherAgentOneLiner("http://127.0.0.1:8000");
    assert.match(cmd, /LOCAL_PUBLISHER_API=http:\/\/127\.0\.0\.1:8000/);
    assert.match(cmd, /bash -c /);
    assert.doesNotMatch(cmd, /sean-mccarthy/);
    assert.doesNotMatch(cmd, /(?:^|\s)\.\/scripts\/run-local-publisher\.sh/);
  });
});
