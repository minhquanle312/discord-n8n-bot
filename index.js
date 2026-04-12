require("dotenv").config();

const express = require("express");
const axios = require("axios");
const {
  ActionRowBuilder,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  StringSelectMenuBuilder,
} = require("discord.js");

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const app = express();
app.use(express.json());

const pendingOutcomes = new Map();
const PENDING_OUTCOME_TTL_MS = 15 * 60 * 1000;

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

async function sendToN8n(payload) {
  const webhookToken = process.env.N8N_WEBHOOK_TOKEN;

  if (!webhookToken) {
    throw new Error("N8N_WEBHOOK_TOKEN is not configured.");
  }

  const response = await axios.post(process.env.N8N_WEBHOOK_URL, payload, {
    headers: {
      "Content-Type": "application/json",
      "x-discord-key": webhookToken,
    },
    timeout: 30000,
  });

  return response.data;
}

function cleanupExpiredPendingOutcomes() {
  const now = Date.now();

  for (const [pendingId, entry] of pendingOutcomes.entries()) {
    if (entry.expiresAt <= now) {
      pendingOutcomes.delete(pendingId);
    }
  }
}

function createAccountSelectionRow(pendingId, accountOptions) {
  const options = accountOptions.slice(0, 25).map((option) => ({
    label: String(option.label ?? option.value ?? "Unknown").slice(0, 100),
    value: String(option.value ?? option.label ?? "unknown").slice(0, 100),
    description: option.description
      ? String(option.description).slice(0, 100)
      : undefined,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`out-account:${pendingId}`)
      .setPlaceholder("Select the payment account")
      .addOptions(options),
  );
}

function formatCurrency(amount) {
  if (!Number.isFinite(amount)) {
    return "unknown amount";
  }

  return `${new Intl.NumberFormat("en-US").format(amount)} VND`;
}

client.on(Events.InteractionCreate, async (interaction) => {
  cleanupExpiredPendingOutcomes();

  if (interaction.isStringSelectMenu()) {
    if (!interaction.customId.startsWith("out-account:")) {
      return;
    }

    const pendingId = interaction.customId.replace("out-account:", "");
    const pendingOutcome = pendingOutcomes.get(pendingId);

    if (!pendingOutcome || pendingOutcome.userId !== interaction.user.id) {
      await interaction.update({
        content:
          "This pending outcome request is no longer available. Please run `/out` again.",
        components: [],
      });
      return;
    }

    await interaction.update({
      content: "Got it. Saving your transaction...",
      components: [],
    });

    try {
      const response = await sendToN8n({
        command: "out",
        mode: "finalize",
        submittedAt: pendingOutcome.draft.date_time,
        outcome: {
          draft: pendingOutcome.draft,
          account_id: interaction.values[0],
        },
      });

      if (response?.status !== "complete") {
        throw new Error(response?.message || "Unable to finalize the outcome.");
      }

      pendingOutcomes.delete(pendingId);

      const transaction = response.transaction ?? {};

      await interaction.editReply({
        content:
          `Saved outcome successfully. ` +
          `[account: ${transaction.account_id}] ` +
          `[amount: ${formatCurrency(Number(transaction.amount))}] ` +
          `[category: ${transaction.category || "(blank)"}] ` +
          `[note: ${transaction.note || pendingOutcome.draft.note}]` +
          (response?.warning ? `\nWarning: ${response.warning}` : ""),
        components: [],
      });
    } catch (error) {
      console.error(
        "Error finalizing outcome via n8n:",
        error?.response?.data || error.message,
      );

      await interaction.editReply({
        content: "Failed to save the transaction. Please run `/out` again.",
        components: [],
      });
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "receipt") {
    const image = interaction.options.getAttachment("image");
    const note = interaction.options.getString("note") || "";

    // Basic validation
    if (!image.contentType || !image.contentType.startsWith("image/")) {
      return interaction.reply({
        content: "Please upload a valid image file for the receipt.",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({
      content: "Processing your receipt...",
      flags: MessageFlags.Ephemeral,
    });

    try {
      const payload = {
        command: "receipt",
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

      await sendToN8n(payload);

      await interaction.followUp({
        content: "Receipt sent to processing workflow successfully.",
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      console.error(
        "Error sending receipt to n8n:",
        error?.response?.data || error.message,
      );

      await interaction.followUp({
        content:
          "Failed to send receipt to processing workflow. Please try again.",
        flags: MessageFlags.Ephemeral,
      });
    }

    return;
  }

  if (interaction.commandName === "out") {
    const message = interaction.options.getString("message", true);

    try {
      console.log(
        `[interaction] acknowledging /out id=${interaction.id} user=${interaction.user.id}`,
      );

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      console.log(`[interaction] deferred /out id=${interaction.id}`);

      const response = await sendToN8n({
        command: "out",
        mode: "extract",
        outcome: {
          originalMessage: message,
        },
        discordContext: {
          userId: interaction.user.id,
          channelId: interaction.channelId,
          guildId: interaction.guildId,
        },
        submittedAt: new Date().toISOString(),
      });

      if (response?.status === "needs_account") {
        const pendingId = response.pending_id;
        const draft = response.draft;
        const accountOptions = Array.isArray(response.account_options)
          ? response.account_options
          : [];

        if (!pendingId || !draft || accountOptions.length === 0) {
          throw new Error(
            response?.message || "The workflow did not return usable clarification data.",
          );
        }

        pendingOutcomes.set(pendingId, {
          userId: interaction.user.id,
          expiresAt: Date.now() + PENDING_OUTCOME_TTL_MS,
          draft,
        });

        await interaction.editReply({
          content:
            `${response.prompt || "Which account was used for this transaction?"}\n\n` +
            `Detected amount: ${formatCurrency(Number(draft.amount))}\n` +
            `Detected note: ${draft.note}\n` +
            `Detected category: ${draft.category || "(blank)"}` +
            (response.warning ? `\nWarning: ${response.warning}` : ""),
          components: [createAccountSelectionRow(pendingId, accountOptions)],
        });

        return;
      }

      if (response?.status !== "complete") {
        throw new Error(response?.message || "Unable to process the outcome message.");
      }

      const transaction = response.transaction ?? {};

      await interaction.editReply({
        content:
          `Saved outcome successfully. ` +
          `[account: ${transaction.account_id}] ` +
          `[amount: ${formatCurrency(Number(transaction.amount))}] ` +
          `[category: ${transaction.category || "(blank)"}] ` +
          `[note: ${transaction.note}]` +
          (response?.warning ? `\nWarning: ${response.warning}` : ""),
      });
    } catch (error) {
      console.error(
        "Error sending outcome to n8n:",
        error?.response?.data || error.message,
      );

      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({
            content:
              error?.response?.data?.message ||
              "Failed to process the outcome. Please try again.",
          });
        } else {
          await interaction.reply({
            content:
              error?.response?.data?.message ||
              "Failed to process the outcome. Please try again.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch (replyError) {
        console.error(
          "Failed to send /out error response:",
          replyError?.response?.data || replyError.message,
        );
      }
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
