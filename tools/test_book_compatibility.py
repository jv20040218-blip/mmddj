"""Run the published repair's actual pure validator without executing its installer."""
import ast, pathlib, sys, unittest, copy
source_path = pathlib.Path(sys.argv.pop(1))
tree = ast.parse(source_path.read_text(encoding='utf-8'))
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'validate_existing_worldbook')
scope = {}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(source_path), 'exec'), scope)
validate = scope['validate_existing_worldbook']

class BookCompatibilityTests(unittest.TestCase):
    def baseline(self):
        return {'entries': {str(i): {'uid': i, 'key': [], 'keysecondary': [], 'content': 'base', 'disable': False} for i in range(3)}}

    def test_original_baseline(self):
        base = self.baseline()
        self.assertEqual(validate(copy.deepcopy(base), base, 3)['preserved_extra_entries'], 0)

    def test_preserve_forty_custom_entries_and_switches(self):
        base = self.baseline(); world = copy.deepcopy(base)
        world['entries']['0']['disable'] = True
        for i in range(3, 43): world['entries'][str(i)] = {'uid': i, 'key': ['custom'], 'keysecondary': [], 'content': 'user content', 'disable': bool(i % 2)}
        before = copy.deepcopy(world)
        self.assertEqual(validate(world, base, 3)['preserved_extra_entries'], 40)
        self.assertEqual(world, before)

    def test_missing_baseline_uid_rejected(self):
        base = self.baseline(); world = copy.deepcopy(base); del world['entries']['1']
        with self.assertRaisesRegex(AssertionError, 'missing'): validate(world, base, 3)

    def test_invalid_custom_entry_rejected(self):
        base = self.baseline(); world = copy.deepcopy(base); world['entries']['4'] = {'uid': 4}
        with self.assertRaisesRegex(AssertionError, 'keyword'): validate(world, base, 3)

    def test_duplicate_uid_rejected(self):
        base = self.baseline(); world = copy.deepcopy(base); world['entries']['4'] = copy.deepcopy(world['entries']['1'])
        with self.assertRaisesRegex(AssertionError, 'duplicate'): validate(world, base, 3)

unittest.main()
