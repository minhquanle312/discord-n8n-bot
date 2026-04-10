require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { Client, GatewayIntentBits, Events } = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const app = express();
app.use(express.json());

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "receipt") {
    const image = interaction.options.getAttachment("image");
    const note = interaction.options.getString("note") || "";

    // Basic validation
    if (!image.contentType || !image.contentType.startsWith("image/")) {
      return interaction.reply({
        content: "Please upload a valid image file for the receipt.",
        ephemeral: true,
      });
    }

    await interaction.reply({
      content: "Processing your receipt...",
      ephemeral: true,
    });

    try {
      const payload = {
        interactionId: interaction.id,
        user: {
          id: interaction.user.id,
          username: interaction.user.username,
          globalName: interaction.user.globalName || null,
        },
        guild: interaction.guild
          ? {
              id: interaction.guild.id,
              name: interaction.guild.name,
            }
          : null,
        channel: interaction.channel
          ? {
              id: interaction.channel.id,
              name: interaction.channel.name || null,
            }
          : null,
        receipt: {
          url: image.url,
          proxyUrl: image.proxyURL,
          name: image.name,
          size: image.size,
          contentType: image.contentType,
        },
        note,
        submittedAt: new Date().toISOString(),
      };

      await axios.post(process.env.N8N_WEBHOOK_URL, payload, {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 30000,
      });

      await interaction.followUp({
        content: "Receipt sent to processing workflow successfully.",
        ephemeral: true,
      });
    } catch (error) {
      console.error(
        "Error sending receipt to n8n:",
        error?.response?.data || error.message,
      );

      await interaction.followUp({
        content:
          "Failed to send receipt to processing workflow. Please try again.",
        ephemeral: true,
      });
    }
  }
});

// Optional callback endpoint from n8n to send final result to a Discord channel or user
app.post("/n8n-result", async (req, res) => {
  try {
    const { userId, channelId, message } = req.body;

    if (channelId) {
      const channel = await client.channels.fetch(channelId);
      if (channel) {
        await channel.send(message || "Receipt processed.");
      }
    }

    // Optional: DM user
    if (userId) {
      const user = await client.users.fetch(userId);
      if (user) {
        await user.send(message || "Your receipt has been processed.");
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error handling n8n callback:", error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`Callback server running on port ${process.env.PORT || 3000}`);
});

client.login(process.env.DISCORD_TOKEN);
