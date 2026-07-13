# Getting Started with the Research Group Planner

## Opening the Tool

Open `index.html` in your web browser. No server or installation is needed.

## Recommended Workflow

### 1. Set Up Personnel

Go to the **Persons** tab and add your group members. For each person, fill in:

- **Name and role** (e.g. Professor, Postdoc, PhD student)
- **Contract start and end dates**
- **Salary intervals**: Click *Add interval* to define periods with different monthly employer costs. Intervals must cover the full contract without gaps or overlaps. If a salary changes mid-contract, create two intervals (e.g. one for 2024-2025 and another for 2026-onwards).

### 2. Set Up Projects

Switch to the **Projects** tab and add your research projects. For each project, fill in:

- **Type and name** (e.g. DFG, ERC, Faculty)
- **Start and end dates**
- **Budgets**: Personnel, travel, and material budgets in euros

### 3. Create Assignments

Go to the **Assignments** tab to assign people to projects:

- Drag a person chip from the palette onto a project row
- Set the **FTE percentage** (e.g. 50 for half-time) in the editor that appears
- Drag the left or right edge of an assignment bar to resize it (hold **Alt** for day-level precision)
- Click an existing assignment bar to edit its FTE or notes

The tool automatically calculates personnel costs based on the person's salary intervals and the overlap with the assignment period.

### 4. Track Expenses

In the **Expenses** tab, log travel and material costs against projects. Only projects with non-zero travel or material budgets appear in the project dropdown. The overview table at the top shows remaining budgets at a glance.

## Dashboard

The dashboard at the top of the page shows:

- **Free personnel funding** per project (remaining budget after assignments)
- **Warnings** for issues like budget overruns, overlapping salary intervals, FTE over/under-allocation, and date conflicts

Check the warnings regularly to catch problems early.

## Showing Past Items

Each tab has a **Show past projects and contracts** checkbox. When unchecked, expired contracts and finished projects are hidden from view.

## Saving and Loading

- **New**: Start with an empty project
- **Open...**: Load a previously saved `.json` file
- **Save / Save As...**: Save your work to a `.json` file
- **Load test data**: Load bundled sample data (only works when hosted on a server)
- **Undo / Revert**: Step back and forward through your edit history

All changes are reflected immediately in the tables and calculations. There is no separate "save changes" step for edits within a session.

## Tips

- **Table columns** can be resized by dragging the column borders
- **Tables are sortable** -- click any column header to sort by that column
- **Hidden persons and projects** (ticked under *Hide*) are excluded from calculations and the timeline but remain in the data
- The **Extension** column in the Persons and Projects tables shows how many additional months a contract or project would need to cover all assigned work
