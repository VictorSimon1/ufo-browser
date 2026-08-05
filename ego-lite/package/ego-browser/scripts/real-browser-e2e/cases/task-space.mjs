export function taskSpaceCase() {
  return `
    const task = await taskSpaces.useOrCreate(taskName);
    assertEqual(task.name, taskName, "taskSpaces.useOrCreate selects named task");

    const reusedTask = await taskSpaces.useOrCreate(taskName);
    assertEqual(reusedTask.id, task.id, "taskSpaces.useOrCreate reuses an existing named task");

    const spaces = await taskSpaces.list();
    assert(spaces.some((space) => space.name === taskName), "taskSpaces.list includes e2e task");
    const listed = spaces.find((space) => space.name === taskName);
    assertEqual(typeof listed.id, "number", "taskSpaces.list returns numeric ids");
    assertEqual(listed.taskId !== undefined, true, "taskSpaces.list returns taskId");
    assertEqual(typeof listed.ownership, "string", "taskSpaces.list returns ownership");

    const switched = await taskSpaces.switch(task.id);
    assertEqual(switched.id, task.id, "taskSpaces.switch selects by numeric id");
    const switchedByName = await taskSpaces.switch(taskName);
    assertEqual(switchedByName.id, task.id, "taskSpaces.switch selects by name");
    const switchedByNumericString = await taskSpaces.switch(String(task.id));
    assertEqual(switchedByNumericString.id, task.id, "taskSpaces.switch selects by numeric string id");

    await taskSpaces.waitForAgentControl(taskName, { interval: 0.1, timeout: 3 });
    await taskSpaces.takeOver(taskName);
    await taskSpaces.waitForAgentControl(taskName, { interval: 0.1, timeout: 3 });

    const scratch = await taskSpaces.new(taskName + " scratch");
    assertEqual(scratch.name, taskName + " scratch", "taskSpaces.new creates a scratch space");
    const scratchByName = await taskSpaces.switch(scratch.name);
    assertEqual(scratchByName.id, scratch.id, "taskSpaces.new output can be selected by name");
    const closed = await taskSpaces.complete(scratch.id, { keep: false });
    assertEqual(closed.done, true, "taskSpaces.complete closes scratch task");

    await assertRejects(
      () => taskSpaces.complete(scratch.id, { keep: false }),
      "task space not found",
      "taskSpaces.complete reports already-closed task space"
    );

    await taskSpaces.switch(taskName);
    await assertRejects(
      () => taskSpaces.switch(taskName + " missing"),
      "task space not found",
      "taskSpaces.switch reports missing task space"
    );
    await assertRejects(
      () => taskSpaces.useOrCreate(99999999),
      "task space not found",
      "taskSpaces.useOrCreate rejects missing numeric id"
    );
    await assertRejects(
      () => taskSpaces.complete(taskName, {}),
      "requires { keep: boolean }",
      "taskSpaces.complete validates keep option"
    );
    await assertRejects(
      () => taskSpaces.complete("", { keep: false }),
      "requires a task space name or id",
      "taskSpaces.complete validates empty task id"
    );
    await assertRejects(
      () => taskSpaces.waitForAgentControl("", { timeout: 0.1 }),
      "requires a task space name or id",
      "taskSpaces.waitForAgentControl validates task space id"
    );
    await assertRejects(
      () => taskSpaces.takeOver(taskName + " missing"),
      "task space not found",
      "taskSpaces.takeOver reports missing task space"
    );
    await assertRejects(
      () => taskSpaces.claim(taskName + " missing"),
      "task space not found",
      "taskSpaces.claim reports missing task space"
    );
    await assertRejects(
      () => taskSpaces.handOff(taskName + " missing"),
      "task space not found",
      "taskSpaces.handOff reports missing task space"
    );

    // taskSpaces.handOff -> taskSpaces.takeOver cycle: verify ownership transitions via taskSpaces.list
    await taskSpaces.handOff();
    const afterHandoff = await taskSpaces.list();
    const handedOff = afterHandoff.find((s) => s.name === taskName);
    assert(handedOff.ownership !== "agent", "taskSpaces.handOff transfers ownership away from agent");

    await taskSpaces.takeOver();
    const afterTakeover = await taskSpaces.list();
    const taken = afterTakeover.find((s) => s.name === taskName);
    assertEqual(taken.ownership, "agent", "taskSpaces.takeOver restores agent ownership");

    await taskSpaces.waitForAgentControl(taskName, { interval: 0.1, timeout: 5 });

    // Repeat with explicit name parameter
    await taskSpaces.handOff(taskName);
    const afterHandoff2 = await taskSpaces.list();
    assert(afterHandoff2.find((s) => s.name === taskName).ownership !== "agent", "taskSpaces.handOff(name) transfers ownership away from agent");

    await taskSpaces.takeOver(taskName);
    const afterTakeover2 = await taskSpaces.list();
    assertEqual(afterTakeover2.find((s) => s.name === taskName).ownership, "agent", "taskSpaces.takeOver(name) restores agent ownership");

    await taskSpaces.waitForAgentControl(taskName, { interval: 0.1, timeout: 5 });
  `;
}
