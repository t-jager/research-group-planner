# Research Group Planner

A client-side web application for managing a research group's personnel, projects, and funding.

## Features

- **Personnel Management**: Track staff members, their roles, contracts, and time-varying salary intervals.
- **Project Management**: Manage research projects with defined budgets (personnel, travel, material) and timelines.
- **Assignment Planning**: Assign personnel to projects with specific FTE percentages. The tool automatically calculates personnel costs based on overlapping salary intervals.
- **Expense Tracking**: Log travel, material, and other expenses against project budgets.
- **Visual Timeline**: A drag-and-drop timeline for visualizing assignments across projects and personnel.
- **Dashboard & Warnings**: A dashboard showing free funding and a warning system for issues like budget overruns, FTE over/under-allocation, and date conflicts.
- **File I/O**: Supports creating, opening, and saving project data as JSON files.

## Usage

Simply open `index.html` in a web browser. No server or build step is required.

The **Load test data** button only works when hosted on a server (e.g. GitHub Pages), since it fetches the bundled test data file via HTTP. When running locally, you can load test data by using **Open...** and selecting the `research-group-planner-testdata.json` file from the local file system.
