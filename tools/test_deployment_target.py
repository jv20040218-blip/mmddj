"""Exercise the actual installer's target-selection block, not a duplicated selector.

python test_deployment_target.py /path/to/install_server.py
"""
import pathlib, tempfile, json, re, sys, unittest

source_path = pathlib.Path(sys.argv.pop(1)).resolve()
source = source_path.read_text(encoding='utf-8-sig')
start = source.find('selection = re.search(')
if start < 0:
    start = source.index("target = user / 'characters/")
end = source.index('stamp = datetime.', start)
block = compile(source[start:end], str(source_path), 'exec')
workspace = pathlib.Path(__file__).resolve().parent


class DeploymentTargetTests(unittest.TestCase):
    def run_target(self, selected, explicit=None):
        with tempfile.TemporaryDirectory(prefix='avatar-target-', dir=workspace) as folder:
            user = pathlib.Path(folder).resolve()
            assert user.parent == workspace, 'Temporary cleanup must stay in the intended workspace'
            (user / 'characters').mkdir()
            settings = {} if selected is ... else {'active_character': selected}
            (user / 'settings.json').write_text(json.dumps(settings), encoding='utf-8')
            for name, version, module in [
                ('明日方舟·剧情完整版_插件版.png', '1.7.0', True),
                ('明日方舟·剧情完整版_插件版1.png', '1.5.1', True),
                ('unrelated.png', 'other', False)]:
                card = {'data': {'character_version': version, 'extensions': {'tavern_helper': {'scripts': [{'name': 'ARK_UI'}] if module else []}}}}
                (user / 'characters' / name).write_text(json.dumps(card), encoding='utf-8')
            env = {'user': user, 'pathlib': pathlib, 're': re, 'json': json,
                   'auth': {'target_avatar': explicit} if explicit else {},
                   'readcard': lambda data: json.loads(data)}
            exec(block, env)
            return env['target'].name, env['original']['data']['character_version']

    def test_selected_suffix_is_updated_instead_of_default(self):
        self.assertEqual(self.run_target('明日方舟·剧情完整版_插件版1.png'), ('明日方舟·剧情完整版_插件版1.png', '1.5.1'))

    def test_selected_default(self):
        self.assertEqual(self.run_target('明日方舟·剧情完整版_插件版.png')[1], '1.7.0')

    def test_unrelated_is_not_overwritten(self):
        with self.assertRaises(AssertionError): self.run_target('unrelated.png')

    def test_unknown_target_is_not_guessed(self):
        with self.assertRaises(AssertionError): self.run_target(...)

    def test_path_escape_is_rejected(self):
        with self.assertRaises(AssertionError): self.run_target('../unrelated.png')

    def test_explicit_module_target_is_respected(self):
        self.assertEqual(self.run_target('unrelated.png', explicit='明日方舟·剧情完整版_插件版.png')[0], '明日方舟·剧情完整版_插件版.png')


if __name__ == '__main__': unittest.main()
