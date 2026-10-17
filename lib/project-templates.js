// Starting points for new projects: each template is a list of sections, and each section lists its starter tasks.
// Add or edit templates here; the New project form picks them up automatically.
const PROJECT_TEMPLATES = {
  blank: {
    label: "Blank project",
    sections: [
      { name: "To do", tasks: [] },
      { name: "In progress", tasks: [] },
      { name: "Done", tasks: [] },
    ],
  },
  rack: {
    label: "Rack build-out",
    sections: [
      { name: "Planning", tasks: ["Confirm power budget and PDU capacity", "Confirm cooling and floor tile placement", "Finalise rack elevation"] },
      { name: "Procurement", tasks: ["Order rails, cable management and PDUs", "Order optics and cables"] },
      { name: "Install & rack", tasks: ["Rack and label hardware"] },
      { name: "Cabling", tasks: ["Run and label power", "Run and label network", "Update cabling records"] },
      { name: "Burn-in & validation", tasks: ["Firmware baseline", "Burn-in and stress test", "Verify link and BMC reachability"] },
      { name: "Handover", tasks: ["Update asset inventory", "Hand over to operations"] },
    ],
  },
  refresh: {
    label: "Hardware refresh",
    sections: [
      { name: "Planning", tasks: ["Identify in-scope assets", "Schedule change windows"] },
      { name: "Staging", tasks: ["Receive and inventory new hardware", "Pre-stage firmware and configs"] },
      { name: "Migration", tasks: ["Migrate workloads", "Validate services"] },
      { name: "Decommission", tasks: ["Wipe drives and record certificates", "Remove and return old hardware", "Update asset records"] },
      { name: "Done", tasks: [] },
    ],
  },
  maintenance: {
    label: "Planned maintenance",
    sections: [
      { name: "Prep", tasks: ["Submit change request", "Notify affected teams", "Stage spares on site"] },
      { name: "Change window", tasks: ["Execute change", "Record actions taken"] },
      { name: "Verification", tasks: ["Confirm service health", "Close change request"] },
      { name: "Follow-up", tasks: [] },
    ],
  },
};
const DEFAULT_TEMPLATE = "blank";

module.exports = { PROJECT_TEMPLATES, DEFAULT_TEMPLATE };
