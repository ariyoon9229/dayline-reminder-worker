import admin from "firebase-admin";
import { DateTime } from "luxon";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT GitHub secret.");
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch {
  throw new Error("FIREBASE_SERVICE_ACCOUNT must contain the full service-account JSON.");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "dayline-be96d",
});

const db = admin.firestore();
const messaging = admin.messaging();

const APP_URL = "https://dayline-be96d.web.app/";
const DEFAULT_ZONE = "Europe/Amsterdam";

const LOOKBACK_MINUTES = 15;
const FUTURE_GRACE_MINUTES = 2;

function reminderLabel(minutes, dueTime) {
  if (minutes === 0) return `Due now${dueTime ? ` · ${dueTime}` : ""}`;
  if (minutes === 60) return `Due in 1 hour${dueTime ? ` · ${dueTime}` : ""}`;
  return `Due in ${minutes} minutes${dueTime ? ` · ${dueTime}` : ""}`;
}

function reminderKey(task, minutes) {
  return `${task.dueDate || ""}|${task.dueTime || ""}|${minutes}`;
}

function isDueNow(target, now) {
  const earliest = now.minus({ minutes: LOOKBACK_MINUTES });
  const latest = now.plus({ minutes: FUTURE_GRACE_MINUTES });
  return target >= earliest && target <= latest;
}

async function deleteInvalidTokens(userRef, deviceDocs, response) {
  const invalid = new Set([
    "messaging/invalid-registration-token",
    "messaging/registration-token-not-registered",
  ]);

  const deletes = [];
  response.responses.forEach((r, i) => {
    const code = r.error?.code;
    if (!r.success && invalid.has(code)) {
      deletes.push(deviceDocs[i].ref.delete());
    }
  });

  if (deletes.length) {
    await Promise.allSettled(deletes);
  }
}

async function processUser(userDoc) {
  const userRef = userDoc.ref;
  const user = userDoc.data() || {};
  const zone = user.timeZone || DEFAULT_ZONE;

  const [tasksSnap, devicesSnap] = await Promise.all([
    userRef.collection("tasks").where("completed", "==", false).get(),
    userRef.collection("devices").get(),
  ]);

  if (devicesSnap.empty || tasksSnap.empty) return { sent: 0, scanned: tasksSnap.size };

  const deviceDocs = devicesSnap.docs.filter(d => Boolean(d.data()?.token));
  const tokens = deviceDocs.map(d => d.data().token);
  if (!tokens.length) return { sent: 0, scanned: tasksSnap.size };

  const now = DateTime.utc();
  let sent = 0;

  for (const taskDoc of tasksSnap.docs) {
    const task = taskDoc.data() || {};
    if (!task.dueDate || !task.dueTime) continue;

    const reminders = Array.isArray(task.reminders)
      ? task.reminders.map(Number).filter(Number.isFinite)
      : [];
    if (!reminders.length) continue;

    const due = DateTime.fromFormat(
      `${task.dueDate} ${task.dueTime}`,
      "yyyy-MM-dd HH:mm",
      { zone }
    );

    if (!due.isValid) continue;

    const already = new Set(Array.isArray(task.serverNotified) ? task.serverNotified : []);

    for (const minutes of reminders) {
      const key = reminderKey(task, minutes);
      if (already.has(key)) continue;

      const target = due.minus({ minutes });
      if (!isDueNow(target.toUTC(), now)) continue;

      const message = {
        tokens,
        notification: {
          title: task.title || "Dayline",
          body: reminderLabel(minutes, task.dueTime),
        },
        data: {
          url: APP_URL,
          taskId: taskDoc.id,
          reminderKey: key,
        },
        webpush: {
          fcmOptions: {
            link: APP_URL,
          },
          notification: {
            icon: `${APP_URL}icon-192.png`,
            badge: `${APP_URL}favicon-32.png`,
            tag: `dayline-${taskDoc.id}-${minutes}`,
            renotify: false,
          },
        },
      };

      const response = await messaging.sendEachForMulticast(message);
      const successCount = response.successCount;

      await deleteInvalidTokens(userRef, deviceDocs, response);

      if (successCount > 0) {
        await taskDoc.ref.set(
          {
            serverNotified: admin.firestore.FieldValue.arrayUnion(key),
            lastServerNotificationAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        sent += successCount;
        console.log(
          `Sent ${successCount} push(es): ${task.title} / ${minutes} min / ${zone}`
        );
      } else {
        console.warn(`No successful push for task ${taskDoc.id}: ${task.title}`);
      }
    }
  }

  return { sent, scanned: tasksSnap.size };
}

async function main() {
  const usersSnap = await db.collection("users").get();

  let totalSent = 0;
  let totalTasks = 0;

  for (const userDoc of usersSnap.docs) {
    try {
      const result = await processUser(userDoc);
      totalSent += result.sent;
      totalTasks += result.scanned;
    } catch (err) {
      console.error(`User ${userDoc.id} failed:`, err);
    }
  }

  console.log(
    `Done. Users=${usersSnap.size}, active tasks scanned=${totalTasks}, pushes sent=${totalSent}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
