import { SlashCommandBuilder } from "discord.js";
import { STATUS_VALUES } from "../crypto";

export function buildCommands() {
  const reply = new SlashCommandBuilder()
    .setName("reply")
    .setDescription("Preview a reply to the hunter. Nothing is sent until you press Send.")
    .setDMPermission(false)
    .addStringOption((option) =>
      option.setName("text").setDescription("Markdown body, sent verbatim after Send").setRequired(false).setMaxLength(6000),
    );
  const note = new SlashCommandBuilder()
    .setName("note")
    .setDescription("Preview a private Mantis note. The hunter does not see it.")
    .setDMPermission(false)
    .addStringOption((option) =>
      option.setName("text").setDescription("Note body").setRequired(false).setMaxLength(6000),
    );
  const status = new SlashCommandBuilder()
    .setName("status")
    .setDescription("Preview a status change. The hunter can see the status and the note.")
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("value")
        .setDescription("New status")
        .setRequired(true)
        .addChoices(...STATUS_VALUES.map((value) => ({ name: value, value }))),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Optional note, visible to the hunter")
        .setRequired(false)
        .setMaxLength(4000),
    );
  const open = new SlashCommandBuilder()
    .setName("open")
    .setDescription("Ask Triage to fetch a flagged submission after a human review.")
    .setDMPermission(false);
  return [reply, note, status, open];
}
