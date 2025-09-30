import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import fs from "fs";
import express from "express";
import dotenv from "dotenv";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
});

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PREFIX = "!";
const CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const SUGGESTIONS_CHANNEL_ID = process.env.SUGGESTIONS_CHANNEL_ID;
const WINNER_ROLE_ID = process.env.WINNER_ROLE_ID;
const LOGS_CHANNEL_ID = process.env.LOGS_CHANNEL_ID;
const DATA_FILE = "./leaderboard.json";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin123';

// -------------------- Data Management --------------------
let leaderboard = {};
let lastSave = Date.now();
const SAVE_INTERVAL = 30000; // Save every 30 seconds instead of every message

// Command cooldowns and mute role storage
const cooldowns = new Map();
const mutedUserRoles = new Map();
const COOLDOWN_TIME = 3000; // 3 seconds

// Load leaderboard data
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    leaderboard = raw ? JSON.parse(raw) : {};
    console.log(`✅ Loaded leaderboard data (${Object.keys(leaderboard).length} users)`);
  } catch (err) {
    console.error("❌ Failed to load leaderboard.json, starting fresh.", err);
    leaderboard = {};
  }
}

function saveData(force = false) {
  if (!force && Date.now() - lastSave < SAVE_INTERVAL) return;
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(leaderboard, null, 2));
    lastSave = Date.now();
  } catch (err) {
    console.error("❌ Failed to save leaderboard:", err);
  }
}

// -------------------- Auth Middleware --------------------
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  
  if (auth === `Bearer ${DASHBOARD_PASSWORD}`) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
}

// -------------------- Express Routes --------------------
// Main Routes
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Discord Bot Dashboard</title></head>
    <body style="font-family: Arial; padding: 20px; background: #f0f0f0;">
      <h1>🤖 Discord Bot Dashboard</h1>
      <p>Bot Status: <span style="color: ${client.isReady() ? 'green' : 'red'};">${client.isReady() ? '✅ Online' : '❌ Offline'}</span></p>
      <p>Access the full dashboard: <a href="/dashboard">Dashboard</a></p>
      <h3>API Endpoints:</h3>
      <ul>
        <li><a href="/api/status">/api/status</a> - Bot status</li>
        <li><a href="/api/leaderboard">/api/leaderboard</a> - Current leaderboard</li>
        <li><a href="/health">/health</a> - Health check</li>
      </ul>
      <p><strong>Note:</strong> Save the dashboard HTML from the artifact as <code>public/index.html</code> to access the full dashboard.</p>
    </body>
    </html>
  `);
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Public API Routes (no auth needed for stats viewing)
app.get("/api/status", (req, res) => {
  const guild = client.guilds.cache.first();
  res.json({
    online: client.isReady(),
    members: guild ? guild.memberCount : 0,
    users: Object.keys(leaderboard).length,
    messages: Object.values(leaderboard).reduce((a, b) => a + b, 0),
    uptime: process.uptime(),
    botTag: client.user ? client.user.tag : "Unknown",
    mutedUsers: mutedUserRoles.size
  });
});

app.get("/api/leaderboard", (req, res) => {
  res.json(leaderboard);
});

app.get("/api/members", async (req, res) => {
  try {
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error("Guild not found");
    
    await guild.members.fetch();
    
    const members = guild.members.cache.map(member => ({
      id: member.user.id,
      username: member.user.username,
      discriminator: member.user.discriminator,
      bot: member.user.bot,
      joinedAt: member.joinedAt
    }));
    
    res.json(members);
  } catch (error) {
    console.error("API members error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Protected admin endpoints (keep authentication)
app.post("/api/test-leaderboard", requireAuth, async (req, res) => {
  try {
    await sendLeaderboard();
    res.json({ success: true, message: "Leaderboard sent successfully" });
  } catch (error) {
    console.error("API test leaderboard error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/reset-leaderboard", requireAuth, async (req, res) => {
  try {
    leaderboard = {};
    saveData(true);
    res.json({ success: true, message: "Leaderboard reset successfully" });
  } catch (error) {
    console.error("API reset leaderboard error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/announcement", requireAuth, async (req, res) => {
  try {
    const { channel, message } = req.body;
    
    let channelId;
    switch (channel) {
      case 'leaderboard':
        channelId = CHANNEL_ID;
        break;
      case 'suggestions':
        channelId = SUGGESTIONS_CHANNEL_ID;
        break;
      case 'logs':
        channelId = LOGS_CHANNEL_ID;
        break;
      default:
        channelId = CHANNEL_ID;
    }

    const discordChannel = await client.channels.fetch(channelId);
    if (!discordChannel) {
      throw new Error("Channel not found");
    }

    const embed = new EmbedBuilder()
      .setTitle("📢 Dashboard Announcement")
      .setDescription(message)
      .setColor("Blue")
      .setTimestamp()
      .setFooter({ text: "Sent via Web Dashboard" });

    await discordChannel.send({ embeds: [embed] });
    res.json({ success: true, message: "Announcement sent successfully" });
  } catch (error) {
    console.error("API announcement error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/api/logs", (req, res) => {
  // Return basic logs - in production, you'd store these in a database
  res.json([
    { time: new Date().toISOString(), message: "✅ Bot started successfully" },
    { time: new Date(Date.now() - 300000).toISOString(), message: `📊 Loaded leaderboard data (${Object.keys(leaderboard).length} users)` },
    { time: new Date(Date.now() - 600000).toISOString(), message: `🔄 Bot uptime: ${Math.floor(process.uptime() / 60)} minutes` }
  ]);
});

// Moderation API Endpoints
app.post("/api/moderation/kick", requireAuth, async (req, res) => {
  try {
    const { userId, reason } = req.body;
    
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error("Guild not found");
    
    const member = await guild.members.fetch(userId);
    if (!member) throw new Error("Member not found");
    
    await member.kick(reason || "Kicked via dashboard");
    res.json({ success: true, message: "User kicked successfully" });
  } catch (error) {
    console.error("API kick error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/ban", requireAuth, async (req, res) => {
  try {
    const { userId, reason } = req.body;
    
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error("Guild not found");
    
    const member = await guild.members.fetch(userId);
    if (!member) throw new Error("Member not found");
    
    await member.ban({ reason: reason || "Banned via dashboard" });
    res.json({ success: true, message: "User banned successfully" });
  } catch (error) {
    console.error("API ban error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/unban", requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error("Guild not found");
    
    await guild.members.unban(userId);
    res.json({ success: true, message: "User unbanned successfully" });
  } catch (error) {
    console.error("API unban error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/timeout", requireAuth, async (req, res) => {
  try {
    const { userId, duration, reason } = req.body;
    
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error("Guild not found");
    
    const member = await guild.members.fetch(userId);
    if (!member) throw new Error("Member not found");
    
    await member.timeout((duration || 10) * 60 * 1000, reason || "Timed out via dashboard");
    res.json({ success: true, message: "User timed out successfully" });
  } catch (error) {
    console.error("API timeout error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/untimeout", requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error("Guild not found");
    
    const member = await guild.members.fetch(userId);
    if (!member) throw new Error("Member not found");
    
    await member.timeout(null);
    res.json({ success: true, message: "Timeout removed successfully" });
  } catch (error) {
    console.error("API untimeout error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/mute", requireAuth, async (req, res) => {
  try {
    const { userId, reason } = req.body;
    
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error("Guild not found");
    
    const member = await guild.members.fetch(userId);
    if (!member) throw new Error("Member not found");
    
    if (mutedUserRoles.has(userId)) {
      throw new Error("User is already muted");
    }
    
    let muteRole = guild.roles.cache.find((r) => r.name === "Muted");
    
    if (!muteRole) {
      muteRole = await guild.roles.create({
        name: "Muted",
        color: "Grey",
        permissions: [],
      });
      
      const channels = guild.channels.cache;
      for (const [, channel] of channels) {
        try {
          await channel.permissionOverwrites.edit(muteRole, {
            SendMessages: false,
            Speak: false,
            AddReactions: false,
          });
        } catch (err) {
          console.error(`Failed to set permissions for channel ${channel.name}:`, err);
        }
      }
    }
    
    const userRoles = member.roles.cache
      .filter(role => role.id !== guild.id)
      .map(role => role.id);
    
    mutedUserRoles.set(userId, userRoles);
    await member.roles.set([muteRole.id]);
    
    res.json({ success: true, message: "User muted successfully", rolesRemoved: userRoles.length });
  } catch (error) {
    console.error("API mute error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/unmute", requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    
    const guild = client.guilds.cache.first();
    if (!guild) throw new Error("Guild not found");
    
    const member = await guild.members.fetch(userId);
    if (!member) throw new Error("Member not found");
    
    if (!mutedUserRoles.has(userId)) {
      throw new Error("User wasn't muted with role storage system");
    }
    
    const storedRoles = mutedUserRoles.get(userId);
    const muteRole = guild.roles.cache.find((r) => r.name === "Muted");
    
    const validRoles = storedRoles.filter(roleId => {
      const role = guild.roles.cache.get(roleId);
      return role && (!muteRole || role.id !== muteRole.id);
    });
    
    await member.roles.set(validRoles);
    mutedUserRoles.delete(userId);
    
    res.json({ success: true, message: "User unmuted successfully", rolesRestored: validRoles.length });
  } catch (error) {
    console.error("API unmute error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/api/moderation/clear", requireAuth, async (req, res) => {
  try {
    const { channelId, amount } = req.body;
    
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error("Channel not found");
    
    if (amount < 1 || amount > 100) {
      throw new Error("Amount must be between 1 and 100");
    }
    
    await channel.bulkDelete(amount, true);
    res.json({ success: true, message: `Deleted ${amount} messages` });
  } catch (error) {
    console.error("API clear error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    uptime: process.uptime(),
    users: Object.keys(leaderboard).length,
    botOnline: client.isReady(),
    memory: process.memoryUsage()
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Express error:", error);
  res.status(500).json({ success: false, error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Dashboard server running on port ${PORT}`);
  console.log(`📊 Access dashboard at: http://localhost:${PORT}/dashboard`);
});

// -------------------- Discord Bot Logic --------------------

// Remove winner role from all members
async function removeWinnerRole(guild) {
  try {
    const role = await guild.roles.fetch(WINNER_ROLE_ID);
    if (!role) {
      console.error("❌ Winner role not found!");
      return;
    }
    for (const [, member] of role.members) {
      try {
        await member.roles.remove(WINNER_ROLE_ID);
        console.log(`✅ Removed winner role from ${member.user.tag}`);
      } catch (err) {
        console.error(`❌ Failed to remove role from ${member.user.tag}:`, err);
      }
    }
  } catch (err) {
    console.error("❌ Error removing winner role:", err);
  }
}

async function giveWinnerRole(guild, winnerId) {
  try {
    const member = await guild.members.fetch(winnerId);
    if (!member) return;
    await member.roles.add(WINNER_ROLE_ID);
    console.log(`✅ Gave winner role to ${member.user.tag}`);
  } catch (err) {
    console.error(`❌ Failed to give winner role to ${winnerId}:`, err);
  }
}

async function sendLeaderboard() {
  try {
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel) {
      console.error("❌ Leaderboard channel not found!");
      return;
    }
    const guild = channel.guild;

    await removeWinnerRole(guild);

    const sorted = Object.entries(leaderboard)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (sorted.length === 0) {
      await channel.send("📊 No messages recorded this week!");
      return;
    }

    const medalEmojis = ["🥇", "🥈", "🥉"];
    const top3 = sorted
      .slice(0, 3)
      .map(([id, count], i) => `#${i + 1} <@${id}> with **${count}** messages ${medalEmojis[i]}`)
      .join("\n");
    const next7 = sorted
      .slice(3)
      .map(([id, count], i) => `#${i + 4} <@${id}> with **${count}** messages`)
      .join("\n");

    const top3Winners = sorted.slice(0, 3);
    let mentionMessage = "🎉 **This week's top winners:** ";
    if (top3Winners.length >= 1) mentionMessage += `🥇 <@${top3Winners[0][0]}>`;
    if (top3Winners.length >= 2) mentionMessage += ` 🥈 <@${top3Winners[1][0]}>`;
    if (top3Winners.length >= 3) mentionMessage += ` 🥉 <@${top3Winners[2][0]}>`;
    mentionMessage += " 🎉";

    const totalMessages = Object.values(leaderboard).reduce((a, b) => a + b, 0);
    const embed = new EmbedBuilder()
      .setTitle("🏆 Weekly Leaderboard Winners")
      .setColor("Blue")
      .setDescription(`${top3}\n\n${next7 || ""}\n\n📊 **Total Messages This Week:** ${totalMessages}\n🔄 The leaderboard will now reset!`)
      .setImage(
        "https://media.discordapp.net/attachments/1420424697501192293/1420428275381178368/3c907b8f-7bc7-48d6-8f40-773308e211da.png?ex=68d55c6b&is=68d40aeb&hm=ceda1d988eaee48ee6c3c94059827cb8c5fcf1f94bf2e3eb4b17233b6fb4e00e&=&format=webp&quality=lossless&width=908&height=605"
      )
      .setFooter({
        text: `Leaderboard | ${new Date().toLocaleDateString(
          "en-GB"
        )} ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
      });

    await channel.send({
      content: mentionMessage,
      embeds: [embed],
      allowedMentions: { parse: ["users"] },
    });

    if (sorted.length > 0) await giveWinnerRole(guild, sorted[0][0]);

    leaderboard = {};
    saveData(true);
    console.log("✅ Weekly leaderboard sent and reset");
  } catch (err) {
    console.error("❌ Error sending leaderboard:", err);
  }
}

async function logAction(embed) {
  try {
    if (LOGS_CHANNEL_ID) {
      const logsChannel = await client.channels.fetch(LOGS_CHANNEL_ID);
      if (logsChannel) {
        await logsChannel.send({ embeds: [embed] });
      }
    }
  } catch (err) {
    console.error("❌ Failed to send log:", err);
  }
}

function checkCooldown(userId, commandName) {
  const key = `${userId}-${commandName}`;
  const now = Date.now();
  
  if (cooldowns.has(key)) {
    const expirationTime = cooldowns.get(key) + COOLDOWN_TIME;
    if (now < expirationTime) {
      const timeLeft = (expirationTime - now) / 1000;
      return timeLeft;
    }
  }
  
  cooldowns.set(key, now);
  return false;
}

// -------------------- Message Counting with Rate Limiting --------------------
client.on("messageCreate", (msg) => {
  if (msg.author.bot) return;
  if (!leaderboard[msg.author.id]) leaderboard[msg.author.id] = 0;
  leaderboard[msg.author.id]++;
  saveData(); // Will only save every 30 seconds due to rate limiting
});

// -------------------- Enhanced Command Handler --------------------
client.on("messageCreate", async (msg) => {
  if (msg.author.bot || !msg.content.startsWith(PREFIX)) return;
  
  const args = msg.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // Check cooldown
  const timeLeft = checkCooldown(msg.author.id, command);
  if (timeLeft) {
    return msg.reply(`⏰ Please wait ${timeLeft.toFixed(1)} seconds before using this command again.`)
      .then(reply => setTimeout(() => reply.delete().catch(() => {}), 5000));
  }

  try {
    // Test Leaderboard Command
    if (command === "testlb") {
      if (!msg.member.permissions.has("Administrator")) {
        return msg.reply("❌ You need Administrator permissions to use this command.");
      }
      await sendLeaderboard();
      await msg.react("✅").catch(() => {});
    }

    // Enhanced Suggestion Command
    if (command === "suggestion") {
      const suggestionText = args.join(" ");
      if (!suggestionText) {
        return msg.reply("❌ Please provide a suggestion! Usage: `!suggestion Your suggestion here`")
          .then(reply => setTimeout(() => reply.delete().catch(() => {}), 5000));
      }
      
      if (suggestionText.length > 1000) {
        return msg.reply("❌ Suggestion too long! Please keep it under 1000 characters.")
          .then(reply => setTimeout(() => reply.delete().catch(() => {}), 5000));
      }

      const suggestionsChannel = await client.channels.fetch(SUGGESTIONS_CHANNEL_ID);
      if (!suggestionsChannel) {
        return msg.reply("❌ Suggestions channel not found!");
      }

      const embed = new EmbedBuilder()
        .setTitle("💡 New Suggestion")
        .setDescription(suggestionText)
        .setColor("Yellow")
        .setAuthor({
          name: msg.author.displayName || msg.author.username,
          iconURL: msg.author.displayAvatarURL(),
        })
        .setTimestamp()
        .setFooter({ text: `User ID: ${msg.author.id}` });

      const suggestionMsg = await suggestionsChannel.send({ embeds: [embed] });
      await suggestionMsg.react("✅");
      await suggestionMsg.react("❌");

      await msg.react("✅");
      await msg.delete().catch(() => {});
    }

    // Enhanced Moderation Commands
    if (command === "kick") {
      if (!msg.member.permissions.has("KickMembers")) {
        return msg.reply("❌ You need Kick Members permission to use this command.");
      }
      
      const member = msg.mentions.members.first();
      if (!member) return msg.reply("❌ Please mention a user to kick!");
      
      if (member.roles.highest.position >= msg.member.roles.highest.position && msg.author.id !== msg.guild.ownerId) {
        return msg.reply("❌ You cannot kick this user (role hierarchy).");
      }

      const reason = args.slice(1).join(" ") || "No reason provided";
      
      try {
        await member.kick(reason);
        msg.reply(`✅ Kicked ${member.user.tag} | Reason: ${reason}`);

        const embed = new EmbedBuilder()
          .setTitle("👢 User Kicked")
          .setColor("Orange")
          .addFields(
            { name: "User", value: `${member.user.tag} (${member.id})`, inline: true },
            { name: "Moderator", value: `${msg.author.tag}`, inline: true },
            { name: "Reason", value: reason, inline: false }
          )
          .setTimestamp();
        logAction(embed);
      } catch (error) {
        msg.reply("❌ Failed to kick user. Check my permissions and role hierarchy.");
      }
    }

    if (command === "ban") {
      if (!msg.member.permissions.has("BanMembers")) {
        return msg.reply("❌ You need Ban Members permission to use this command.");
      }
      
      const member = msg.mentions.members.first();
      if (!member) return msg.reply("❌ Please mention a user to ban!");
      
      if (member.roles.highest.position >= msg.member.roles.highest.position && msg.author.id !== msg.guild.ownerId) {
        return msg.reply("❌ You cannot ban this user (role hierarchy).");
      }

      const reason = args.slice(1).join(" ") || "No reason provided";
      
      try {
        await member.ban({ reason });
        msg.reply(`✅ Banned ${member.user.tag} | Reason: ${reason}`);

        const embed = new EmbedBuilder()
          .setTitle("🔨 User Banned")
          .setColor("Red")
          .addFields(
            { name: "User", value: `${member.user.tag} (${member.id})`, inline: true },
            { name: "Moderator", value: `${msg.author.tag}`, inline: true },
            { name: "Reason", value: reason, inline: false }
          )
          .setTimestamp();
        logAction(embed);
      } catch (error) {
        msg.reply("❌ Failed to ban user. Check my permissions and role hierarchy.");
      }
    }

    if (command === "unban") {
      if (!msg.member.permissions.has("BanMembers")) {
        return msg.reply("❌ You need Ban Members permission to use this command.");
      }
      
      const userId = args[0];
      if (!userId) return msg.reply("❌ Please provide a user ID to unban.");
      
      try {
        await msg.guild.members.unban(userId);
        msg.reply(`✅ User <@${userId}> has been unbanned.`);

        const embed = new EmbedBuilder()
          .setTitle("✅ User Unbanned")
          .setColor("Green")
          .addFields(
            { name: "User ID", value: userId, inline: true },
            { name: "Moderator", value: `${msg.author.tag}`, inline: true }
          )
          .setTimestamp();
        logAction(embed);
      } catch (error) {
        msg.reply("❌ Failed to unban user. Check the user ID and my permissions.");
      }
    }

    if (command === "timeout") {
      if (!msg.member.permissions.has("ModerateMembers")) {
        return msg.reply("❌ You need Moderate Members permission to use this command.");
      }
      
      const member = msg.mentions.members.first();
      const duration = parseInt(args[1]) || 10;
      const reason = args.slice(2).join(" ") || "No reason provided";
      
      if (!member) return msg.reply("❌ Please mention a user to timeout!");
      if (duration < 1 || duration > 1440) return msg.reply("❌ Duration must be between 1 and 1440 minutes (24 hours).");
      
      try {
        await member.timeout(duration * 60 * 1000, reason);
        msg.reply(`✅ Timed out ${member.user.tag} for ${duration} minutes | Reason: ${reason}`);

        const embed = new EmbedBuilder()
          .setTitle("⏲️ User Timed Out")
          .setColor("Yellow")
          .addFields(
            { name: "User", value: `${member.user.tag} (${member.id})`, inline: true },
            { name: "Duration", value: `${duration} minutes`, inline: true },
            { name: "Moderator", value: `${msg.author.tag}`, inline: true },
            { name: "Reason", value: reason, inline: false }
          )
          .setTimestamp();
        logAction(embed);
      } catch (error) {
        msg.reply("❌ Failed to timeout user. Check my permissions.");
      }
    }

    if (command === "untimeout") {
      if (!msg.member.permissions.has("ModerateMembers")) {
        return msg.reply("❌ You need Moderate Members permission to use this command.");
      }
      
      const member = msg.mentions.members.first();
      if (!member) return msg.reply("❌ Please mention a user to remove timeout!");
      
      try {
        await member.timeout(null);
        msg.reply(`✅ Removed timeout from ${member.user.tag}`);

        const embed = new EmbedBuilder()
          .setTitle("✅ Timeout Removed")
          .setColor("Green")
          .addFields(
            { name: "User", value: `${member.user.tag} (${member.id})`, inline: true },
            { name: "Moderator", value: `${msg.author.tag}`, inline: true }
          )
          .setTimestamp();
        logAction(embed);
      } catch (error) {
        msg.reply("❌ Failed to remove timeout. Check my permissions.");
      }
    }

    // Enhanced Mute with Role Storage
    if (command === "mute") {
      if (!msg.member.permissions.has("ModerateMembers")) {
        return msg.reply("❌ You need Moderate Members permission to use this command.");
      }
      
      const member = msg.mentions.members.first();
      if (!member) return msg.reply("❌ Please mention a user to mute!");

      if (mutedUserRoles.has(member.id)) {
        return msg.reply("❌ This user is already muted!");
      }

      let muteRole = msg.guild.roles.cache.find((r) => r.name === "Muted");

      if (!muteRole) {
        try {
          muteRole = await msg.guild.roles.create({
            name: "Muted",
            color: "Grey",
            permissions: [],
          });
          
          const channels = msg.guild.channels.cache;
          for (const [, channel] of channels) {
            try {
              await channel.permissionOverwrites.edit(muteRole, {
                SendMessages: false,
                Speak: false,
                AddReactions: false,
              });
            } catch (err) {
              console.error(`Failed to set permissions for channel ${channel.name}:`, err);
            }
          }
          
          msg.channel.send("🔧 Created `Muted` role with proper permissions.");
        } catch (err) {
          console.error("❌ Failed to create Muted role:", err);
          return msg.reply("❌ Couldn't create Muted role. Check my permissions.");
        }
      }

      const reason = args.slice(1).join(" ") || "No reason provided";

      try {
        // Store user's current roles (excluding @everyone)
        const userRoles = member.roles.cache
          .filter(role => role.id !== msg.guild.id)
          .map(role => role.id);
        
        mutedUserRoles.set(member.id, userRoles);
        
        // Remove all roles except @everyone and add mute role
        await member.roles.set([muteRole.id]);
        
        msg.reply(`✅ Muted ${member.user.tag} | Removed ${userRoles.length} role(s) | Reason: ${reason}`);

        const embed = new EmbedBuilder()
          .setTitle("🔇 User Muted")
          .setColor("Grey")
          .addFields(
            { name: "User", value: `${member.user.tag} (${member.id})`, inline: true },
            { name: "Moderator", value: `${msg.author.tag}`, inline: true },
            { name: "Roles Removed", value: `${userRoles.length} role(s)`, inline: true },
            { name: "Reason", value: reason, inline: false }
          )
          .setTimestamp();
        logAction(embed);
      } catch (error) {
        mutedUserRoles.delete(member.id);
        console.error("Mute error:", error);
        msg.reply("❌ Failed to mute user. Check my permissions and role hierarchy.");
      }
    }

    // Enhanced Unmute with Role Restoration
    if (command === "unmute") {
      if (!msg.member.permissions.has("ModerateMembers")) {
        return msg.reply("❌ You need Moderate Members permission to use this command.");
      }
      
      const member = msg.mentions.members.first();
      if (!member) return msg.reply("❌ Please mention a user to unmute!");

      const muteRole = msg.guild.roles.cache.find((r) => r.name === "Muted");
      if (!muteRole) return msg.reply("❌ No 'Muted' role found.");
      
      if (!mutedUserRoles.has(member.id)) {
        return msg.reply("❌ This user wasn't muted with the role storage system, or their role data was lost.");
      }
      
      try {
        const storedRoles = mutedUserRoles.get(member.id);
        
        const validRoles = storedRoles.filter(roleId => {
          const role = msg.guild.roles.cache.get(roleId);
          return role && role.id !== muteRole.id;
        });
        
        await member.roles.set(validRoles);
        mutedUserRoles.delete(member.id);
        
        msg.reply(`✅ Unmuted ${member.user.tag} | Restored ${validRoles.length} role(s)`);

        const embed = new EmbedBuilder()
          .setTitle("🔊 User Unmuted")
          .setColor("Green")
          .addFields(
            { name: "User", value: `${member.user.tag} (${member.id})`, inline: true },
            { name: "Moderator", value: `${msg.author.tag}`, inline: true },
            { name: "Roles Restored", value: `${validRoles.length} role(s)`, inline: true }
          )
          .setTimestamp();
        logAction(embed);
      } catch (error) {
        console.error("Unmute error:", error);
        msg.reply("❌ Failed to unmute user. Check my permissions.");
      }
    }

    if (command === "clear") {
      if (!msg.member.permissions.has("ManageMessages")) {
        return msg.reply("❌ You need Manage Messages permission to use this command.");
      }
      
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount < 1 || amount > 100) {
        return msg.reply("❌ Please provide a number between 1 and 100.");
      }
      
      try {
        await msg.channel.bulkDelete(amount, true);
        const confirmMsg = await msg.reply(`✅ Deleted ${amount} messages.`);
        setTimeout(() => confirmMsg.delete().catch(() => {}), 3000);

        const embed = new EmbedBuilder()
          .setTitle("🗑️ Messages Cleared")
          .setColor("Blue")
          .addFields(
            { name: "Channel", value: msg.channel.name, inline: true },
            { name: "Amount", value: amount.toString(), inline: true },
            { name: "Moderator", value: `${msg.author.tag}`, inline: true }
          )
          .setTimestamp();
        logAction(embed);
      } catch (error) {
        msg.reply("❌ Failed to delete messages. They might be too old or I lack permissions.");
      }
    }

    // Permission-based Help Command
    if (command === "help") {
      const isAdmin = msg.member.permissions.has("Administrator");
      const isModerator = msg.member.permissions.has("KickMembers") || 
                         msg.member.permissions.has("BanMembers") || 
                         msg.member.permissions.has("ModerateMembers");

      const embed = new EmbedBuilder()
        .setTitle("🤖 Bot Commands")
        .setColor("Blue")
        .setFooter({ text: "Commands shown based on your permissions" })
        .setTimestamp();

      embed.addFields(
        { name: "💡 Suggestions", value: "`!suggestion <text>` - Submit a suggestion", inline: false },
        { name: "ℹ️ Info", value: "`!help` - Show this help message", inline: false }
      );

      if (isAdmin) {
        embed.addFields(
          { name: "📊 Admin Commands", value: "`!testlb` - Test leaderboard", inline: false }
        );
      }

      if (isModerator || isAdmin) {
        embed.addFields(
          { name: "🛡️ Moderation Commands", value: "`!kick @user [reason]`\n`!ban @user [reason]`\n`!unban <userid>`\n`!timeout @user [minutes] [reason]`\n`!untimeout @user`\n`!mute @user [reason]`\n`!unmute @user`\n`!clear <amount>`", inline: false }
        );
      }

      await msg.reply({ embeds: [embed] });
    }

  } catch (error) {
    console.error(`Error executing command ${command}:`, error);
    msg.reply("❌ An error occurred while executing this command.").catch(() => {});
  }
});

// -------------------- Cron Jobs --------------------
cron.schedule("0 0 * * 0", () => {
  console.log("🕐 Running weekly leaderboard...");
  sendLeaderboard();
});

// Save data periodically
cron.schedule("*/5 * * * *", () => {
  saveData(true);
  console.log("💾 Periodic data save completed");
});

// -------------------- Ready & Error Events --------------------
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🔗 Bot is in ${client.guilds.cache.size} server(s)`);
  console.log(`📊 Leaderboard has ${Object.keys(leaderboard).length} users`);
  console.log("🚀 Bot is fully ready!");
});

client.on("error", (error) => {
  console.error("❌ Discord client error:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Unhandled promise rejection:", error);
});

process.on("SIGINT", () => {
  console.log("👋 Bot shutting down...");
  saveData(true); // Save data before exit
  client.destroy();
  process.exit(0);
});

client.login(process.env.TOKEN);