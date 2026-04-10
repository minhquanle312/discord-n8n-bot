require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("receipt")
    .setDescription("Upload a receipt for expense tracking")
    .addAttachmentOption((option) =>
      option.setName("image").setDescription("Receipt image").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Optional note about this expense")
        .setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("outcome")
    .setDescription("Note outcome")
    .addAttachmentOption((option) =>
      option.setName("image").setDescription("Receipt image").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("note")
        .setDescription("Optional note about this expense")
        .setRequired(false),
    )
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID,
        process.env.DISCORD_GUILD_ID,
      ),
      { body: commands },
    );
    console.log("Slash commands registered successfully.");
  } catch (error) {
    console.error(error);
  }
})();
