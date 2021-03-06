namespace Frida {
	public int main (string[] args) {
		Posix.setsid ();

		Gum.init ();

		var parent_address = args[1];
		var service = new LinuxHelperService (parent_address);
		return service.run ();
	}

	public class LinuxHelperService : Object, LinuxRemoteHelper {
		public string parent_address {
			get;
			construct;
		}

		private MainLoop loop = new MainLoop ();
		private int run_result = 0;
		private Gee.Promise<bool> shutdown_request;

		private DBusConnection connection;
		private uint helper_registration_id = 0;

		private LinuxHelperBackend backend = new LinuxHelperBackend ();

		public LinuxHelperService (string parent_address) {
			Object (parent_address: parent_address);
		}

		construct {
			backend.idle.connect (on_backend_idle);
			backend.output.connect (on_backend_output);
			backend.uninjected.connect (on_backend_uninjected);
		}

		public int run () {
			Idle.add (() => {
				start.begin ();
				return false;
			});

			loop.run ();

			return run_result;
		}

		private async void shutdown () {
			if (shutdown_request != null) {
				try {
					yield shutdown_request.future.wait_async ();
				} catch (Gee.FutureError e) {
					assert_not_reached ();
				}
				return;
			}
			shutdown_request = new Gee.Promise<bool> ();

			if (connection != null) {
				if (helper_registration_id != 0)
					connection.unregister_object (helper_registration_id);

				connection.on_closed.disconnect (on_connection_closed);
				try {
					yield connection.close ();
				} catch (GLib.Error connection_error) {
				}
				connection = null;
			}

			yield backend.close ();
			backend.idle.disconnect (on_backend_idle);
			backend.output.disconnect (on_backend_output);
			backend.uninjected.disconnect (on_backend_uninjected);
			backend = null;

			shutdown_request.set_value (true);

			Idle.add (() => {
				loop.quit ();
				return false;
			});
		}

		private async void start () {
			try {
				connection = yield new DBusConnection.for_address (parent_address, DBusConnectionFlags.AUTHENTICATION_CLIENT | DBusConnectionFlags.DELAY_MESSAGE_PROCESSING);
				connection.on_closed.connect (on_connection_closed);

				LinuxRemoteHelper helper = this;
				helper_registration_id = connection.register_object (Frida.ObjectPath.HELPER, helper);

				connection.start_message_processing ();
			} catch (GLib.Error e) {
				printerr ("Unable to start: %s\n", e.message);
				run_result = 1;
				shutdown.begin ();
			}
		}

		public async void stop () throws Error {
			Timeout.add (20, () => {
				shutdown.begin ();
				return false;
			});
		}

		private void on_backend_idle () {
			if (connection.is_closed ())
				shutdown.begin ();
		}

		private void on_connection_closed (bool remote_peer_vanished, GLib.Error? error) {
			if (backend.is_idle)
				shutdown.begin ();
		}

		public async uint spawn (string path, HostSpawnOptions options) throws Error {
			return yield backend.spawn (path, options);
		}

		public async void prepare_exec_transition (uint pid) throws Error {
			yield backend.prepare_exec_transition (pid);
		}

		public async void await_exec_transition (uint pid) throws Error {
			yield backend.await_exec_transition (pid);
		}

		public async void cancel_exec_transition (uint pid) throws Error {
			yield backend.cancel_exec_transition (pid);
		}

		public async void input (uint pid, uint8[] data) throws Error {
			yield backend.input (pid, data);
		}

		public async void resume (uint pid) throws Error {
			yield backend.resume (pid);
		}

		public async void kill (uint pid) throws Error {
			yield backend.kill (pid);
		}

		public async uint inject_library_file (uint pid, string path, string entrypoint, string data, string temp_path) throws Error {
			return yield backend.inject_library_file (pid, path, entrypoint, data, temp_path);
		}

		public async uint demonitor_and_clone_injectee_state (uint id) throws Error {
			return yield backend.demonitor_and_clone_injectee_state (id);
		}

		public async void recreate_injectee_thread (uint pid, uint id) throws Error {
			yield backend.recreate_injectee_thread (pid, id);
		}

		private void on_backend_output (uint pid, int fd, uint8[] data) {
			output (pid, fd, data);
		}

		private void on_backend_uninjected (uint id) {
			uninjected (id);
		}
	}
}
