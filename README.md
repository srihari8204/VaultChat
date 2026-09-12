# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Coding with OpenSpec and Ponytail

[OpenSpec](https://github.com/Fission-AI/OpenSpec) manages proposals, specs, and
implementation tasks. [Ponytail](https://github.com/DietrichGebert/ponytail) guides
small, correct implementations and reviews unnecessary complexity. The shared
workflow is in [AGENTS.md](AGENTS.md), with project constraints in
[openspec/config.yaml](openspec/config.yaml).

For a new developer machine with Node.js and Codex installed:

```sh
npm install -g @fission-ai/openspec@1.4.1
openspec init --tools codex
codex plugin marketplace add DietrichGebert/ponytail
codex plugin add ponytail@ponytail
```

Restart Codex after installation. In Codex CLI, use `/hooks` to review and trust
Ponytail's lifecycle hooks if you want automatic plugin activation. The project
rules in `AGENTS.md` provide the implementation guidance without those hooks.
On Windows, ensure the npm global bin directory (`npm prefix -g`) is on PATH.

Start with `openspec list --json` to find existing work. In a Codex prompt, use
`$openspec-propose <feature>` to plan or `$openspec-apply-change <change>` to
implement, and ask Ponytail to review the resulting diff. Validate artifacts
with `openspec validate <change> --strict` and run the relevant project checks.

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
