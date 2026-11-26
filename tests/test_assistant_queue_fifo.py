"""#521: a message submitted later never runs before an earlier message that is still queued.

After a runtime failure the queue stays paused (#379). A newer message used to start
at once through POST /turns, or resume the paused queue through POST /messages. These
cases record the real execution order from the runtime stub and use events and
barriers instead of sleeps.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import threading
from uuid import UUID, uuid4, uuid5

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app
from opendirector_api import agent
from test_assistant_queue import empty_skills, frames, wait_until

PENDING_ZH = '此对话中更早排队的消息还没有执行'
PENDING_EN = 'Earlier queued messages in this conversation have not run yet'


class Harness:
    def __init__(self, store, config, stack, session):
        self.store, self.config, self.stack, self.session = store, config, stack, session
        self.seen, self.contexts, self.settings = [], {}, {}
        self.started, self.held, self.failing, self.ids = {}, {}, set(), {}
        self.client = self.path = self.cid = None
        self.pid = str(uuid4())
        self.open(create=True)

    def open(self, create=False):
        self.client = self.stack.enter_context(TestClient(create_app(self.store), headers={
            'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': self.session}))
        root = f'/api/creation/projects/{self.pid}'
        if create:
            assert self.client.post(root + '/commands', json={'type': 'project.create', 'projectId': self.pid,
                'commandId': str(uuid4()), 'payload': {'name': '顺序'}}).status_code == 200
        assert self.client.post(root + '/open').status_code == 200
        self.path = root + '/assistant'
        self.cid = self.client.get(self.path).json()['conversationId']

    def restart(self):
        """A new app on the same store: nothing in memory survives, the files do."""
        self.stack.close()
        self.stack = ExitStack()
        self.open()

    def body(self, text, thinking='auto'):
        self.ids.setdefault(text, str(uuid4()))
        return {'id': self.ids[text], 'runtime': 'default', 'conversationId': self.cid, 'text': text,
                'thinking': thinking,
                'modelSelections': {'agent': self.config['id'], 'image': None, 'video': None, 'audio': None}}

    def turn(self, text, **options):
        return self.client.post(self.path + '/turns', json=self.body(text, **options))

    def message(self, text, **options):
        return self.client.post(self.path + '/messages', json=self.body(text, **options))

    def post(self, action, **json):
        return self.client.post(self.path + '/queue/' + action, json=json or None)

    def hold(self, *texts):
        for text in texts:
            self.held[text] = threading.Event()

    def started_event(self, text):
        return self.started.setdefault(text, threading.Event())

    def order(self):
        return [text for text, _ in self.seen]

    def stored(self):
        return [(item['role'], item['status'], item['text'][:8])
                for item in self.client.get(self.path).json()['messages']]

    def queued(self):
        return [item['text'] for item in self.client.get(self.path).json()['messages']
                if item['status'] == 'queued']

    def fail_then_queue(self, *queued):
        """一 fails while the given messages are queued behind it; the paused queue is left."""
        self.failing.add('一')
        self.hold('一')
        with ThreadPoolExecutor() as pool:
            running = pool.submit(self.turn, '一')
            assert self.started_event('一').wait(5)
            for text in queued:
                assert self.message(text).status_code == 202
            self.held['一'].set()
            events = frames(running.result(timeout=10))
        assert events[-1]['type'] == 'end' and events[-1]['error']
        assert self.order() == ['一']
        assert self.queued() == list(queued)


@pytest.fixture
def harness(tmp_path, monkeypatch):
    config = {'id': str(uuid4()), 'modelId': 'test-model', 'kind': 'agent', 'url': 'http://models.test/v1',
              'connectionType': 'api', 'protocol': 'openai', 'authMode': 'none', 'apiKey': ''}
    stack = ExitStack()
    state = {}

    async def stream(self, run):
        # The turn is identified by its id: which message the context ends with is #519's concern.
        text = next(name for name, key in state['h'].ids.items() if key == str(run.turn_id))
        state['h'].seen.append((text, [(item['role'], item['content'].partition('\n')[0])
                                       for item in run.messages]))
        state['h'].settings[text] = run.thinking
        state['h'].started_event(text).set()
        if text in state['h'].held:
            await asyncio.to_thread(state['h'].held[text].wait, 10)
        if text in state['h'].failing:
            raise RuntimeError('runtime exploded')
        yield {'type': 'delta', 'text': '回复' + text}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args, **kwargs: dict(config))
    h = state['h'] = Harness(LocalProjects(tmp_path), config, stack, str(uuid4()))
    try:
        yield h
    finally:
        for event in h.held.values():
            event.set()
        h.stack.close()


def test_a_message_submitted_after_a_failed_turn_cannot_start_ahead_of_the_queue(harness):
    h = harness
    h.fail_then_queue('二')
    assert h.stored() == [('user', 'complete', '一'), ('assistant', 'interrupted', ''),
                          ('user', 'queued', '二')]
    # 1 + 2: 三 through /turns is refused and nothing runs.
    refused = frames(h.turn('三'))
    assert refused[-1]['type'] == 'end' and refused[-1]['conversation'] is None
    assert PENDING_ZH in refused[-1]['error']
    assert h.order() == ['一']
    assert h.queued() == ['二'] and all(text != '三' for _, _, text in h.stored())
    # The same refusal in English, with its stable code on the error text.
    english = h.client.post(h.path + '/turns', json=h.body('四'), headers={'Accept-Language': 'en'})
    assert PENDING_EN in frames(english)[-1]['error']
    assert h.order() == ['一']
    # 三 through /messages is accepted at the tail and the queue stays paused.
    accepted = h.message('三')
    assert accepted.status_code == 202
    assert accepted.json()['paused'] is True
    assert accepted.json()['chainId'] is None and accepted.json()['turnId'] is None
    assert accepted.json()['queued']['status'] == 'queued'
    assert accepted.json()['queued']['queueSeq'] > h.client.get(h.path).json()['messages'][2]['queueSeq']
    assert h.order() == ['一']
    assert h.queued() == ['二', '三']


def test_continue_runs_the_paused_queue_in_submission_order_with_frozen_settings(harness):
    h = harness
    h.failing.add('一')
    h.hold('一')
    with ThreadPoolExecutor() as pool:
        running = pool.submit(h.turn, '一')
        assert h.started_event('一').wait(5)
        assert h.message('二', thinking='low').status_code == 202
        h.held['一'].set()
        frames(running.result(timeout=10))
    assert h.message('三', thinking='high').status_code == 202
    assert h.order() == ['一']
    resumed = h.post('continue')
    assert resumed.status_code == 200
    events = frames(resumed)
    assert h.order() == ['一', '二', '三']
    assert (h.settings['二'], h.settings['三']) == ('low', 'high')
    assert [event['nextTurnId'] is None for event in events if event['type'] == 'end'] == [False, True]
    assert h.stored()[2:] == [('user', 'complete', '二'), ('assistant', 'complete', '回复二'),
                              ('user', 'complete', '三'), ('assistant', 'complete', '回复三')]
    # With the queue resolved a direct turn is accepted again.
    frames(h.turn('四'))
    assert h.order() == ['一', '二', '三', '四']


def test_several_queued_messages_resume_in_order_through_one_continue(harness):
    h = harness
    h.fail_then_queue('二', '三')
    assert h.message('四').status_code == 202
    events = frames(h.post('continue'))
    assert h.order() == ['一', '二', '三', '四']
    ends = [event for event in events if event['type'] == 'end']
    assert [event['nextTurnId'] is None for event in ends] == [False, False, True]
    assert h.queued() == []


def test_a_failure_while_resuming_pauses_the_rest_again(harness):
    h = harness
    h.fail_then_queue('二', '三')
    h.failing.add('二')
    events = frames(h.post('continue'))
    assert h.order() == ['一', '二'] and events[-1]['error']
    assert h.queued() == ['三']
    h.failing.clear()
    frames(h.post('continue'))
    assert h.order() == ['一', '二', '三']


def test_a_finish_persistence_failure_never_lets_a_later_message_overtake(harness, monkeypatch):
    h = harness
    original = agent.durable_json
    reply = {}

    def lose_the_final_write(file, value):
        target = reply.get('id')
        if target and any(item['id'] == target and item['status'] != 'streaming' for item in value['messages']):
            reply.pop('id')
            raise OSError('disk full')
        return original(file, value)

    monkeypatch.setattr(agent, 'durable_json', lose_the_final_write)
    h.hold('一')
    reply['id'] = str(uuid5(UUID(h.body('一')['id']), 'assistant'))
    with ThreadPoolExecutor() as pool:
        running = pool.submit(h.turn, '一')
        assert h.started_event('一').wait(5)
        assert h.message('二').status_code == 202
        h.held['一'].set()
        frames(running.result(timeout=10))
    assert 'id' not in reply
    # 一's final write was lost, so its reply stays as it was last stored.
    lost_reply_then_both = [('user', 'complete', '一'), ('assistant', 'streaming', ''),
                            ('user', 'complete', '二'), ('assistant', 'complete', '回复二'),
                            ('user', 'complete', '三'), ('assistant', 'complete', '回复三')]
    # The one observable that tells the trees apart is whether 二 is still queued once the
    # first chain has ended. Either way, 三 never runs before 二.
    if not h.queued():
        # This tree (main semantics, #502): the failed finish write still reads 'complete'
        # in memory, so the chain dispatched 二 and nothing is left waiting. 三 may start.
        assert h.order() == ['一', '二']
        assert h.stored() == lost_reply_then_both[:4]
        sent = h.message('三')
        assert sent.status_code == 200
        frames(sent)
        assert h.order() == ['一', '二', '三']
        assert h.queued() == []
        assert h.stored() == lost_reply_then_both
    else:
        # A tree that also contains PR #512: the failed write stops the chain, 二 stays queued.
        assert h.order() == ['一']
        assert h.stored() == [*lost_reply_then_both[:2], ('user', 'queued', '二')]
        refused = h.turn('三')
        assert refused.status_code == 200
        end = frames(refused)[-1]
        assert end['type'] == 'end' and PENDING_ZH in end['error'] and end['conversation'] is None
        assert h.order() == ['一']
        parked = h.message('三')
        assert parked.status_code == 202 and parked.json()['paused'] is True
        assert h.queued() == ['二', '三'] and h.order() == ['一']
        frames(h.post('continue'))
        assert h.order() == ['一', '二', '三']
        assert h.queued() == []
        assert h.stored() == lost_reply_then_both


def test_stop_still_cancels_the_rest_and_then_allows_a_new_turn(harness):
    h = harness
    h.hold('一')
    with ThreadPoolExecutor() as pool:
        running = pool.submit(h.turn, '一')
        assert h.started_event('一').wait(5)
        assert h.message('二').status_code == 202 and h.message('三').status_code == 202
        assert h.client.post(h.path + f"/turns/{h.ids['一']}/stop").status_code == 200
        frames(running.result(timeout=10))
    assert [item[:2] for item in h.stored()] == [
        ('user', 'complete'), ('assistant', 'stopped'), ('user', 'cancelled'), ('user', 'cancelled')]
    assert h.queued() == []
    assert h.post('continue').status_code == 409
    frames(h.turn('四'))
    assert h.order() == ['一', '四']


def test_cancel_gives_a_failed_queue_the_same_cancelled_state_as_stop(harness):
    h = harness
    h.fail_then_queue('二', '三')
    cancelled = h.post('cancel')
    assert cancelled.status_code == 200
    assert [item['text'] for item in cancelled.json()['cancelled']] == ['二', '三']
    assert [item[:2] for item in h.stored()] == [
        ('user', 'complete'), ('assistant', 'interrupted'), ('user', 'cancelled'), ('user', 'cancelled')]
    assert h.post('cancel').json() == {'cancelled': []}
    frames(h.turn('四'))
    assert h.order() == ['一', '四']


def test_a_restart_keeps_the_queue_paused_until_continue(harness):
    h = harness
    h.fail_then_queue('二')
    h.restart()
    assert h.queued() == ['二']
    # Nothing replays by itself, however long the new app has been up.
    assert not h.started_event('二').wait(0.3)
    assert h.order() == ['一']
    assert PENDING_ZH in frames(h.turn('三'))[-1]['error']
    assert h.order() == ['一']
    accepted = h.message('三')
    assert accepted.status_code == 202 and accepted.json()['paused'] is True
    frames(h.post('continue'))
    assert h.order() == ['一', '二', '三']


def test_duplicate_ids_stay_idempotent_and_repeated_calls_are_safe(harness):
    h = harness
    h.fail_then_queue('二')
    assert h.message('三').status_code == 202
    duplicate = h.message('三')
    assert duplicate.status_code == 409 and '已接受' in duplicate.json()['detail']
    assert h.queued() == ['二', '三']
    # A duplicate of the already queued 二 through /turns is refused without a second entry.
    assert '已接受' in frames(h.turn('二'))[-1]['error'] and h.queued() == ['二', '三']
    h.hold('二')
    with ThreadPoolExecutor() as pool:
        first = pool.submit(h.post, 'continue')
        assert h.started_event('二').wait(5)
        # While the chain runs, a second continue and a cancel are both refused.
        assert h.post('continue').status_code == 409
        assert h.post('cancel').status_code == 409
        h.held['二'].set()
        frames(first.result(timeout=10))
    assert h.order() == ['一', '二', '三']
    again = h.post('continue')
    assert again.status_code == 409 and again.json()['code'] == 'no_queued_messages'
    assert h.post('cancel').json() == {'cancelled': []}
    assert [text for _, _, text in h.stored()].count('二') == 1
    assert [text for _, _, text in h.stored()].count('三') == 1


def test_a_continue_for_another_conversation_is_refused(harness):
    h = harness
    h.fail_then_queue('二')
    other = h.post('continue', conversationId=str(uuid4()))
    assert other.status_code == 409 and '对话已切换' in other.json()['detail']
    assert h.post('cancel', conversationId=str(uuid4())).status_code == 409
    assert h.queued() == ['二'] and h.order() == ['一']


def test_two_concurrent_continues_start_exactly_one_chain(harness):
    h = harness
    h.fail_then_queue('二')
    h.hold('二')
    barrier = threading.Barrier(2)

    def resume():
        barrier.wait(5)
        return h.post('continue')

    with ThreadPoolExecutor() as pool:
        calls = [pool.submit(resume), pool.submit(resume)]
        assert h.started_event('二').wait(5)
        assert wait_until(lambda: any(call.done() for call in calls))
        done = next(call for call in calls if call.done())
        assert done.result().status_code == 409
        h.held['二'].set()
        frames(next(call for call in calls if call is not done).result(timeout=10))
    assert h.order() == ['一', '二']


def test_continue_racing_a_new_turn_never_lets_the_new_turn_run_first(harness):
    h = harness
    h.fail_then_queue('二')
    h.hold('二')
    barrier = threading.Barrier(2)

    def start(call):
        barrier.wait(5)
        return call()

    with ThreadPoolExecutor() as pool:
        resumed = pool.submit(start, lambda: h.post('continue'))
        racing = pool.submit(start, lambda: h.turn('三'))
        assert h.started_event('二').wait(5)
        # 三 is refused either because 二 is queued or because 二 is running.
        refused = racing.result(timeout=10)
        if refused.status_code == 200:
            assert PENDING_ZH in frames(refused)[-1]['error']
        else:
            assert refused.status_code == 409
        assert h.order() == ['一', '二']
        h.held['二'].set()
        assert resumed.result(timeout=10).status_code == 200
    assert wait_until(lambda: h.queued() == [] and h.stored()[-1][1] == 'complete')
    assert h.order() == ['一', '二'] and '三' not in [text for _, _, text in h.stored()]


def test_a_dispatched_turn_sees_its_own_message_and_nothing_submitted_later(harness):
    h = harness
    h.fail_then_queue('二')
    h.hold('二')
    with ThreadPoolExecutor() as pool:
        resumed = pool.submit(h.post, 'continue')
        assert h.started_event('二').wait(5)
        assert h.message('三').status_code == 202
        h.held['二'].set()
        frames(resumed.result(timeout=10))
    context = dict(h.seen)['二']
    assert ('user', '二') in context
    assert all('三' not in content for _, content in context)
    assert h.order() == ['一', '二', '三']
