import csv
import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('results', Path(__file__).parents[2]/'scripts/experiment-results.py')
RESULTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RESULTS)


class ResultsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.csv = Path(self.temp.name)/'runs.csv'

    def write(self, rows):
        with self.csv.open('w', newline='') as handle:
            writer = csv.DictWriter(handle, fieldnames=RESULTS.COLUMNS)
            writer.writeheader()
            writer.writerows(rows)

    def row(self, **changes):
        row = dict.fromkeys(RESULTS.COLUMNS, '')
        row.update(run_id='qa-1', block='1', condition='baseline', network='connected', variant='A',
                   completed='true', duration_s='120', manual_interventions='3')
        row.update(changes)
        return row

    def test_empty_template_refuses_to_invent_results(self):
        self.write([])
        with self.assertRaisesRegex(ValueError, 'No measured runs'):
            RESULTS.read_runs(self.csv)

    def test_incomplete_trials_are_not_fast_completion_times(self):
        self.write([self.row(), self.row(run_id='qa-2', completed='false', duration_s='30')])
        group = RESULTS.summarize(RESULTS.read_runs(self.csv))['groups'][0]
        self.assertEqual(group['runs'], 2)
        self.assertEqual(group['completed'], 1)
        self.assertEqual(group['metrics']['duration_s'], {'n': 1, 'median': 120})
        self.assertEqual(group['metrics']['decision_latency_s'], {'n': 0, 'median': None})

    def test_duplicate_ids_rejected(self):
        self.write([self.row(), self.row()])
        with self.assertRaisesRegex(ValueError, 'duplicate run_id'):
            RESULTS.read_runs(self.csv)

    def test_nonfinite_negative_and_fractional_counts_rejected(self):
        for field, value in [('duration_s', 'nan'), ('duration_s', '-1'), ('manual_interventions', '1.5')]:
            with self.subTest(field=field, value=value):
                self.write([self.row(**{field: value})])
                with self.assertRaises(ValueError):
                    RESULTS.read_runs(self.csv)

    def test_transport_replay_not_fabricated_for_baseline(self):
        self.write([self.row(network='partition', replay_s='0')])
        with self.assertRaisesRegex(ValueError, 'Catalyst transport replay'):
            RESULTS.read_runs(self.csv)

    def test_partition_recovery_and_unknown_metrics(self):
        self.write([self.row(condition='catalyst', network='partition', recovery_s='12', replay_s='2')])
        groups = RESULTS.summarize(RESULTS.read_runs(self.csv))['groups']
        self.assertEqual(groups[0]['runs'], 0)
        self.assertEqual(groups[3]['metrics']['recovery_s']['median'], 12)


if __name__ == '__main__':
    unittest.main()
