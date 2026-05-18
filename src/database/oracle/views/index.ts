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
import './v_archive_dest';
import './v_bgprocess';
import './v_buffer_pool';
import './v_buffer_pool_statistics';
import './v_bh';
import './v_backup_set';
import './v_backup_piece';
import './v_backup_files';
import './v_backup_datafile';
import './v_backup_redolog';
import './v_backup_archivelog_details';
import './v_backup_corruption';
import './v_copy_corruption';
import './v_database_block_corruption';
import './v_db_cache_advice';
import './v_cache_stats';
import './v_shared_pool_advice';
import './v_shared_pool_reserved';
import './v_rowcache';
import './v_rowcache_subordinate';
import './v_rman_status';
import './v_rman_output';
import './v_rman_backup_job_details';
import './v_rman_backup_type';
import './v_java_pool_advice';
import './v_active_services';
import './v_cluster_instance';
import './v_db_object_cache';
import './v_event_name';
import './v_instance_cache_transfer';
import './v_instance_recovery';
import './v_license';
import './v_mystat';
import './v_listener_network';
import './v_librarycache';
import './v_libraryobj';
import './v_libcache_locks';
import './v_nodes';
import './v_rac_global_view';
import './v_thread';
import './v_threads';
import './v_system_event';
import './v_system_wait_class';
import './v_session_event';
import './v_session_longops';
import './v_session_metric';
import './v_session_metric_history';
import './v_sqlstats';
import './v_sql_text';
import './v_sql_text_with_newlines';
import './v_sql_bind_capture';
import './v_sql_shared_cursor';
import './v_sql_shared_memory';
import './v_sql_cursor';
import './v_sql_monitor';
import './v_sql_plan_monitor';
import './v_sql_plan_statistics';
import './v_sql_plan_statistics_all';
import './v_sql_workarea';
import './v_sql_workarea_active';
import './v_sql_workarea_histogram';
import './v_sqlfn_metadata';
import './v_sqlfn_arg_metadata';
import './v_session_connect_info';
import './v_session_wait';
import './v_session_wait_history';
import './v_sess_io';
import './v_sess_time_model';
import './v_statname';
import './v_streams_pool_advice';
import './v_services';
import './v_sgainfo';
import './v_sga_dynamic_components';
import './v_sga_dynamic_free_memory';
import './v_sga_resize_ops';
import './v_sga_current_resize_ops';
import './v_sga_target_advice';
import './v_memory_dynamic_components';
import './v_memory_resize_ops';
import './v_memory_target_advice';
import './v_pgastat';
import './v_process_memory';
import './v_process_memory_detail';
import './v_session_wait_class';

export { };
