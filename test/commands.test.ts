import { GatewayIntentBits } from "discord.js";
import { describe, expect, it } from "vitest";
import { BurstAlert } from "../src/burst";
import { buildCommands } from "../src/discord/commands";
import { createDiscordClient } from "../src/discord/poster";
import { STATUS_VALUES } from "../src/crypto";

describe("discord command surface", () => {
  it("registers the four thread commands without the message content intent", () => {
    const names = buildCommands().map((command) => command.name);
    expect(names).toEqual(["reply", "note", "status", "open"]);
    for (const command of buildCommands()) {
      expect(command.toJSON().dm_permission).toBe(false);
    }
    const status = buildCommands()[2]?.toJSON();
    const value = status?.options?.find((option) => option.name === "value");
    expect(value && "choices" in value ? value.choices?.map((choice) => choice.value) : []).toEqual([...STATUS_VALUES]);
    const client = createDiscordClient();
    expect(client.options.allowedMentions?.parse).toEqual([]);
    expect(client.options.intents.has(GatewayIntentBits.Guilds)).toBe(true);
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(false);
    client.destroy();
  });

  it("alerts once per bad-signature burst", () => {
    const alerts: number[] = [];
    const burst = new BurstAlert(5, 10 * 60 * 1000, (count) => alerts.push(count));
    for (let index = 0; index < 7; index += 1) burst.hit(1_000 + index);
    expect(alerts).toEqual([5]);
    burst.hit(1_000 + 11 * 60 * 1000);
    for (let index = 0; index < 4; index += 1) burst.hit(1_000 + 11 * 60 * 1000 + index);
    expect(alerts).toEqual([5, 5]);
  });
});
