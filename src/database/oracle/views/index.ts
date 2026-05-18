/**
 * Oracle view barrel — loads every view module so each definition gets
 * registered. Adding a new view = create a new file in this folder and
 * add a single import line below. Nothing else needs to change.
 *
 * Order is irrelevant: registration is idempotent. Listed alphabetically
 * for readability.
 */

import './v_active_instances';
import './v_active_session_history';
import './v_bgprocess';
import './v_active_services';
import './v_cluster_instance';
import './v_event_name';
import './v_instance_cache_transfer';
import './v_instance_recovery';
import './v_license';
import './v_listener_network';
import './v_nodes';
import './v_rac_global_view';
import './v_thread';
import './v_threads';
import './v_system_event';
import './v_system_wait_class';
import './v_session_event';
import './v_session_connect_info';
import './v_session_wait';
import './v_session_wait_history';
import './v_services';
import './v_session_wait_class';

export { };
