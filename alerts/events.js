// Every alert a person can turn on or off in Settings > My alerts.
//   requiresAnyOf  a person sees the option only if their access level has at least one of these permissions
//   defaults       what is on before the person changes anything
//   hasPriorityFilter  the person can limit the alert to higher priorities ("P1 and P2" etc.)
const ALERT_EVENTS = {
  ticket_assigned: {
    group: "Tickets", requiresAnyOf: ["tickets.assignable"],
    label: "A ticket is assigned to me",
    defaults: { email: true, sms: false },
  },
  ticket_new_group: {
    group: "Tickets", requiresAnyOf: ["tickets.assignable"], hasPriorityFilter: true,
    label: "A new ticket lands in one of my resolver groups",
    defaults: { email: true, sms: false, minPriority: "P2" },
  },
  ticket_new_p1_any: {
    group: "Tickets", requiresAnyOf: ["tickets.view_all"],
    label: "Any ticket anywhere is raised or escalated to P1",
    defaults: { email: false, sms: false },
  },
  ticket_sla_warning: {
    group: "Tickets", requiresAnyOf: ["tickets.assignable", "tickets.assign"],
    label: "SLA is about to run out (25% of time left) on my tickets",
    hint: "My tickets = assigned to me, or unassigned in my groups. Unrouted tickets go to people who can assign tickets.",
    defaults: { email: true, sms: false },
  },
  ticket_sla_breached: {
    group: "Tickets", requiresAnyOf: ["tickets.assignable", "tickets.assign"],
    label: "SLA is breached on my tickets",
    defaults: { email: true, sms: true },
  },
  ticket_comment: {
    group: "Tickets", requiresAnyOf: ["tickets.assignable"],
    label: "Someone posts an update on a ticket assigned to me",
    defaults: { email: true, sms: false },
  },
  ticket_requester_update: {
    group: "Tickets", requiresAnyOf: ["tickets.create"],
    label: "The desk replies to, needs info on, or resolves a ticket I raised",
    defaults: { email: true, sms: false },
  },
  task_assigned: {
    group: "Projects", requiresAnyOf: ["projects.access"],
    label: "A project task is assigned to me",
    defaults: { email: true, sms: false },
  },
  task_due: {
    group: "Projects", requiresAnyOf: ["projects.access"],
    label: "My task is due tomorrow or is overdue",
    defaults: { email: true, sms: false },
  },
  task_comment: {
    group: "Projects", requiresAnyOf: ["projects.access"],
    label: "Someone comments on a task assigned to me or that I created",
    defaults: { email: true, sms: false },
  },
};

// Priority filter choices, from most to least selective. "P2" means "P1 and P2".
const PRIORITY_RANK = { P1: 1, P2: 2, P3: 3, P4: 4 };

module.exports = { ALERT_EVENTS, PRIORITY_RANK };
