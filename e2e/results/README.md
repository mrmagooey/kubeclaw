# Test Results

This directory contains E2E test results and logs.

## Contents

- `test-results.json` - Raw test results from Vitest
- `*-junit.xml` - JUnit XML format for CI integration
- `*-summary.md` - Markdown summary reports
- `logs/` - Container and application logs
- `coverage/` - Code coverage reports

## Generated Files

These files are generated during test runs and should not be committed:

```
results/
├── test-results.json
├── phase-1-junit.xml
├── phase-1-summary.md
├── phase-2-junit.xml
├── phase-2-summary.md
├── phase-3-junit.xml
├── phase-3-summary.md
├── combined-junit.xml
├── combined-summary.md
├── logs/
│   ├── orchestrator.log
│   ├── redis.log
│   └── pods-describe.log
└── coverage/
    ├── index.html
    └── ...
```

## Viewing Results

### JUnit XML

Import into CI systems like Jenkins, CircleCI, or GitHub Actions.

### Markdown Summary

View directly in GitHub or with any Markdown viewer:

```bash
cat results/combined-summary.md
```

### Coverage Reports

Open `results/coverage/index.html` in a browser.

## Retention

Test results are retained for 7 days in CI artifacts. Local results are not automatically cleaned up.

## Cleaning Up

```bash
# Clean results only
make clean-results

# Full cleanup
make cleanup
```
