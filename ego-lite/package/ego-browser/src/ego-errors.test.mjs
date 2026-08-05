import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNoEgoError,
  egoErrorCode,
  isEgoErrorCode,
  isEgoUserControlError,
  resolveEgoError,
} from "../dist/src/ego-errors.js";

test("egoErrorCode extracts the code from every error shape", () => {
  // resolved { error, error_code } object
  assert.equal(
    egoErrorCode({ error: "nope", error_code: "EGO_BROWSER_UNAVAILABLE" }),
    "EGO_BROWSER_UNAVAILABLE",
  );
  // rejected / thrown Error carrying .error_code
  const err = Object.assign(new Error("boom"), {
    error_code: "EGO_SNAPSHOT_FAILED",
  });
  assert.equal(egoErrorCode(err), "EGO_SNAPSHOT_FAILED");
  // bare known code string (e.g. onSendCDPMessageError second arg)
  assert.equal(
    egoErrorCode("EGO_TASK_SPACE_USER_IN_CONTROL"),
    "EGO_TASK_SPACE_USER_IN_CONTROL",
  );
  // future code this build does not know about is still returned
  assert.equal(
    egoErrorCode({ error_code: "EGO_FUTURE_CODE" }),
    "EGO_FUTURE_CODE",
  );
  // no code present
  assert.equal(egoErrorCode({ error: "plain message" }), undefined);
  assert.equal(egoErrorCode("plain message"), undefined);
});

test("isEgoErrorCode narrows to known codes only", () => {
  assert.equal(isEgoErrorCode("EGO_TASK_SPACE_NOT_FOUND"), true);
  assert.equal(isEgoErrorCode("EGO_FUTURE_CODE"), false);
  assert.equal(isEgoErrorCode(undefined), false);
});

test("resolveEgoError overrides the native error message with the owned wording for an owned code", () => {
  const { code, message } = resolveEgoError({
    error: "Task space 7 is not assigned to an agent.",
    error_code: "EGO_TASK_SPACE_INACTIVE",
  });
  assert.equal(code, "EGO_TASK_SPACE_INACTIVE");
  // Owned id-less guidance replaces the native "Task space 7 ..." text.
  assert.match(message, /taskSpaces\.claim\(id\)/);
  assert.doesNotMatch(message, /\b7\b/);
});

test("resolveEgoError keeps the native error message for an unknown future code", () => {
  assert.deepEqual(
    resolveEgoError({
      error: "Some build-specific detail",
      error_code: "EGO_FUTURE_CODE",
    }),
    {
      code: "EGO_FUTURE_CODE",
      message: "Some build-specific detail",
    },
  );
});

test("resolveEgoError defers to the native error message for a code ego-browser does not own", () => {
  // EGO_OPERATION_FAILED is not owned: the client wording (e.g. which operation
  // failed) is more specific than any static line.
  assert.deepEqual(
    resolveEgoError({
      error: "Failed to create task space",
      error_code: "EGO_OPERATION_FAILED",
    }),
    {
      code: "EGO_OPERATION_FAILED",
      message: "Failed to create task space",
    },
  );
});

test("resolveEgoError falls back to the raw code for a bare non-owned code", () => {
  // ego-browser does not own NOT_SELECTED and a bare code carries no native error message,
  // so the stable code itself is the most specific thing to surface.
  assert.deepEqual(resolveEgoError("EGO_TASK_SPACE_NOT_SELECTED"), {
    code: "EGO_TASK_SPACE_NOT_SELECTED",
    message: "EGO_TASK_SPACE_NOT_SELECTED",
  });
});

test("resolveEgoError uses the id-less guidance block for a bare user-control code", () => {
  const { code, message } = resolveEgoError("EGO_TASK_SPACE_USER_IN_CONTROL");
  assert.equal(code, "EGO_TASK_SPACE_USER_IN_CONTROL");
  assert.match(message, /taken control of this task space/);
  assert.match(message, /taskSpaces\.takeOver\(\)/);
  assert.doesNotMatch(message, /<id>/);
});

test("resolveEgoError falls back to the raw code, then a generic message", () => {
  assert.deepEqual(resolveEgoError({ error_code: "EGO_FUTURE_CODE" }), {
    code: "EGO_FUTURE_CODE",
    message: "EGO_FUTURE_CODE",
  });
  assert.deepEqual(resolveEgoError({}), {
    code: undefined,
    message: "Unknown ego error",
  });
});

test("isEgoUserControlError keys on the stable code, not wording", () => {
  assert.equal(
    isEgoUserControlError(
      Object.assign(new Error("anything at all"), {
        error_code: "EGO_TASK_SPACE_USER_IN_CONTROL",
      }),
    ),
    true,
  );
  // wording that mentions user control but lacks the code is not a match
  assert.equal(
    isEgoUserControlError(new Error("the user is controlling this")),
    false,
  );
  assert.equal(
    isEgoUserControlError({ error_code: "EGO_SNAPSHOT_FAILED" }),
    false,
  );
});

test("assertNoEgoError resolves the message via the code and attaches error_code", () => {
  try {
    assertNoEgoError(
      {
        error: "Task space not selected",
        error_code: "EGO_TASK_SPACE_NOT_SELECTED",
      },
      "listTabs",
    );
    assert.fail("expected assertNoEgoError to throw");
  } catch (err) {
    assert.equal(err.message, "listTabs: Task space not selected");
    assert.equal(err.error_code, "EGO_TASK_SPACE_NOT_SELECTED");
  }
});

test("assertNoEgoError omits the prefix when no op is given", () => {
  try {
    assertNoEgoError({
      error: "The task space is inactive: 10",
      error_code: "EGO_TASK_SPACE_INACTIVE",
    });
    assert.fail("expected assertNoEgoError to throw");
  } catch (err) {
    // No op given, so no "<op>: " prefix — the owned block starts the message.
    assert.match(err.message, /^The user has taken control/);
    assert.match(err.message, /taskSpaces\.claim\(id\)/);
    assert.doesNotMatch(err.message, /\b10\b/);
    assert.equal(err.error_code, "EGO_TASK_SPACE_INACTIVE");
  }
});

test("assertNoEgoError passes through results with no error", () => {
  const ok = { tabs: [] };
  assert.equal(assertNoEgoError(ok, "listTabs"), ok);
});
