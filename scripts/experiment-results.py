#!/usr/bin/env python3
"""Validate measured two-device runs and plot descriptive results; never synthesizes measurements."""
import argparse
import csv
import json
import math
from pathlib import Path
from statistics import median

COLUMNS = ['run_id', 'block', 'condition', 'network', 'variant', 'completed', 'duration_s',
           'decision_latency_s', 'manual_interventions', 'rework_minutes', 'integration_failures',
           'recovery_s', 'replay_s', 'claude_tokens', 'claude_cost', 'notes']
NUMERIC = COLUMNS[6:15]
COUNTS = {'manual_interventions', 'integration_failures', 'claude_tokens'}
GROUPS = [(n, c) for n in ('connected', 'partition') for c in ('baseline', 'catalyst')]


def read_runs(path):
    with path.open(newline='', encoding='utf-8-sig') as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != COLUMNS:
            raise ValueError('CSV header must be: ' + ','.join(COLUMNS))
        runs, ids = [], set()
        for line, raw in enumerate(reader, 2):
            if None in raw or any(v is None for v in raw.values()):
                raise ValueError(f'Line {line}: wrong number of columns')
            row = {k: v.strip() for k, v in raw.items()}
            if not any(row.values()):
                continue
            for field in COLUMNS[:7]:
                if not row[field]:
                    raise ValueError(f'Line {line}: missing {field}')
            if row['run_id'] in ids:
                raise ValueError(f'Line {line}: duplicate run_id')
            ids.add(row['run_id'])
            if row['condition'] not in ('baseline', 'catalyst') or row['network'] not in ('connected', 'partition'):
                raise ValueError(f'Line {line}: invalid condition/network')
            if row['completed'] not in ('true', 'false'):
                raise ValueError(f'Line {line}: completed must be true or false')
            row['completed'] = row['completed'] == 'true'
            for field in NUMERIC:
                try:
                    value = float(row[field]) if row[field] else None
                except ValueError:
                    raise ValueError(f'Line {line}: invalid number for {field}') from None
                if value is not None and (not math.isfinite(value) or value < 0 or (field in COUNTS and not value.is_integer())):
                    raise ValueError(f'Line {line}: {field} must be finite and nonnegative; counts must be integers')
                row[field] = value
            if row['network'] == 'connected' and (row['recovery_s'] is not None or row['replay_s'] is not None):
                raise ValueError(f'Line {line}: recovery_s/replay_s apply only to partition runs')
            if row['condition'] == 'baseline' and row['replay_s'] is not None:
                raise ValueError(f'Line {line}: replay_s is Catalyst transport replay, not a baseline measure')
            runs.append(row)
    if not runs:
        raise ValueError('No measured runs yet. Fill the header-only template with observed data; no charts generated.')
    return runs


def summarize(runs):
    groups = []
    for network, condition in GROUPS:
        rows = [r for r in runs if (r['network'], r['condition']) == (network, condition)]
        metrics = {}
        for field in NUMERIC:
            # Incomplete trials are not short completion times. Their elapsed duration remains in the raw CSV.
            values = [r[field] for r in rows if r[field] is not None and (field != 'duration_s' or r['completed'])]
            metrics[field] = {'n': len(values), 'median': median(values) if values else None}
        groups.append({'network': network, 'condition': condition, 'runs': len(rows),
                       'completed': sum(r['completed'] for r in rows), 'metrics': metrics})
    return {'description': 'Observed descriptive results only; no causal or statistical significance claim.',
            'incomplete_trials': 'Excluded from completion-time medians, included in completion-rate denominators.',
            'groups': groups}


def plot(runs, output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    panels = [('duration_s', 'Completion time (successful runs only)', 'Seconds'),
              ('decision_latency_s', 'Requirement change → teammate informed', 'Seconds'),
              ('manual_interventions', 'Facilitator nudges', 'Count'),
              ('rework_minutes', 'Rework caused by coordination mismatch', 'Minutes'),
              ('recovery_s', 'Resume → shared status consistent', 'Seconds')]
    fig, axes = plt.subplots(2, 3, figsize=(16, 9), layout='constrained')
    labels = ['Git notes\nConnected', 'Catalyst\nConnected', 'Git notes\nPause window', 'Catalyst\nSync paused']
    colors = ['#707783', '#2563eb', '#707783', '#2563eb']
    for ax, (field, title, unit) in zip(axes.flat, panels):
        for idx, (network, condition) in enumerate(GROUPS):
            values = [r[field] for r in runs if (r['network'], r['condition']) == (network, condition)
                      and r[field] is not None and (field != 'duration_s' or r['completed'])]
            for j, value in enumerate(values):
                jitter = 0 if len(values) == 1 else (j / (len(values)-1) - .5) * .28
                ax.scatter(idx + jitter, value, color=colors[idx], alpha=.75, zorder=3)
            if values:
                ax.hlines(median(values), idx-.28, idx+.28, color=colors[idx], linewidth=3)
            ax.text(idx, .98, f'n={len(values)}', ha='center', va='top', transform=ax.get_xaxis_transform(), fontsize=9)
        ax.set(title=title, ylabel=unit, xticks=range(4), xticklabels=labels, xlim=(-.5, 3.5))
        ax.set_ylim(bottom=0)
        ax.grid(axis='y', alpha=.2)
        ax.tick_params(axis='x', labelsize=8)
    ax = axes.flat[-1]
    for idx, (network, condition) in enumerate(GROUPS):
        rows = [r for r in runs if (r['network'], r['condition']) == (network, condition)]
        if rows:
            done = sum(r['completed'] for r in rows)
            ax.bar(idx, 100 * done/len(rows), color=colors[idx], width=.55)
            ax.text(idx, 100 * done/len(rows)+2, f'{done}/{len(rows)}', ha='center')
    ax.set(title='Runs meeting all acceptance tests', ylabel='Percent completed', ylim=(0, 115),
           xticks=range(4), xticklabels=labels)
    ax.tick_params(axis='x', labelsize=8)
    fig.suptitle('Two-device Catalyst comparison — measured runs\nPoints = individual runs; lines = medians. Missing values are not zero.', fontsize=15)
    fig.savefig(output/'comparison.png', dpi=180)
    fig.savefig(output/'comparison.svg')
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('csv', type=Path)
    parser.add_argument('--out', required=True, type=Path, help='Output directory OUTSIDE the repository')
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    try:
        repo = Path(__file__).resolve().parent.parent
        output = args.out.expanduser().resolve()
        if output == repo or repo in output.parents:
            raise ValueError('Keep measured data and chart artifacts outside the repository')
        runs = read_runs(args.csv)
        summary = summarize(runs)
        if args.validate_only:
            print(f'Validated {len(runs)} measured run(s).')
            return
        output.mkdir(parents=True, exist_ok=True)
        plot(runs, output)
        (output/'summary.json').write_text(json.dumps(summary, indent=2)+'\n', encoding='utf-8')
        print(f'Wrote comparison.png, comparison.svg and summary.json to {output}')
    except (ValueError, OSError, ImportError) as exc:
        parser.exit(2, f'Error: {exc}\n')


if __name__ == '__main__':
    main()
