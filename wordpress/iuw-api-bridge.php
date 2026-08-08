<?php
/**
 * Plugin Name: ICE UNDERWATER API Bridge
 * Description: Minimal mu-plugin bridge for the Node API — credential verify, user create, invoice send, custom roles.
 * Author: ICE UNDERWATER
 *
 * Setup:
 * 1. Copy this file to wp-content/mu-plugins/iuw-api-bridge.php
 * 2. Add to wp-config.php:
 *      define('IUW_BRIDGE_SECRET', 'same-value-as-WP_BRIDGE_SECRET');
 *      define('IUW_BRIDGE_ALLOWED_IPS', '1.2.3.4'); // comma-separated API server IPs; empty = secret-only
 * 3. No other WordPress work is required for the Node API.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'init', 'iuw_bridge_register_roles' );
add_action( 'rest_api_init', 'iuw_bridge_register_routes' );

function iuw_bridge_register_roles() {
	add_role(
		'iuw_supplier',
		'IUW Supplier',
		array(
			'read' => true,
		)
	);
	add_role(
		'iuw_admin',
		'IUW Admin',
		array(
			'read'         => true,
			'list_users'   => true,
			'edit_users'   => true,
			'promote_users'=> true,
		)
	);
}

function iuw_bridge_register_routes() {
	register_rest_route(
		'iuw-bridge/v1',
		'/verify',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_verify',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);

	register_rest_route(
		'iuw-bridge/v1',
		'/create-user',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_create_user',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);

	register_rest_route(
		'iuw-bridge/v1',
		'/send-invoice',
		array(
			'methods'             => 'POST',
			'callback'            => 'iuw_bridge_send_invoice',
			'permission_callback' => 'iuw_bridge_authorize',
		)
	);
}

function iuw_bridge_authorize( WP_REST_Request $request ) {
	$secret = defined( 'IUW_BRIDGE_SECRET' ) ? IUW_BRIDGE_SECRET : '';
	$header = $request->get_header( 'x_iuw_bridge_secret' );
	if ( ! $secret || ! hash_equals( $secret, (string) $header ) ) {
		return new WP_Error( 'iuw_bridge_forbidden', 'Forbidden', array( 'status' => 403 ) );
	}

	$allowed = defined( 'IUW_BRIDGE_ALLOWED_IPS' ) ? IUW_BRIDGE_ALLOWED_IPS : '';
	if ( $allowed ) {
		$ips  = array_filter( array_map( 'trim', explode( ',', $allowed ) ) );
		$remote = isset( $_SERVER['REMOTE_ADDR'] ) ? $_SERVER['REMOTE_ADDR'] : '';
		if ( $ips && ! in_array( $remote, $ips, true ) ) {
			return new WP_Error( 'iuw_bridge_forbidden', 'Forbidden', array( 'status' => 403 ) );
		}
	}

	return true;
}

function iuw_bridge_verify( WP_REST_Request $request ) {
	$email    = sanitize_email( (string) $request->get_param( 'email' ) );
	$password = (string) $request->get_param( 'password' );
	if ( ! $email || ! $password ) {
		return new WP_Error( 'iuw_bridge_invalid', 'Email and password are required.', array( 'status' => 400 ) );
	}

	$user = wp_authenticate( $email, $password );
	if ( is_wp_error( $user ) ) {
		$user = wp_authenticate( sanitize_user( $email, true ), $password );
	}
	if ( is_wp_error( $user ) ) {
		return new WP_Error( 'iuw_bridge_invalid_login', 'The login details are incorrect.', array( 'status' => 401 ) );
	}

	return iuw_bridge_user_payload( $user );
}

function iuw_bridge_create_user( WP_REST_Request $request ) {
	$email        = sanitize_email( (string) $request->get_param( 'email' ) );
	$password     = (string) $request->get_param( 'password' );
	$display_name = sanitize_text_field( (string) $request->get_param( 'displayName' ) );
	$roles        = (array) $request->get_param( 'roles' );

	if ( ! $email || ! $password ) {
		return new WP_Error( 'iuw_bridge_invalid', 'Email and password are required.', array( 'status' => 400 ) );
	}
	if ( email_exists( $email ) ) {
		return new WP_Error( 'iuw_bridge_exists', 'An account with this email already exists.', array( 'status' => 409 ) );
	}

	$user_id = wp_insert_user(
		array(
			'user_login'   => $email,
			'user_email'   => $email,
			'user_pass'    => $password,
			'display_name' => $display_name ? $display_name : $email,
			'role'         => 'subscriber',
		)
	);

	if ( is_wp_error( $user_id ) ) {
		return $user_id;
	}

	$user = new WP_User( $user_id );
	$user->set_role( 'subscriber' );
	foreach ( $roles as $role ) {
		$role = sanitize_key( (string) $role );
		if ( $role ) {
			$user->add_role( $role );
		}
	}

	return iuw_bridge_user_payload( $user );
}

function iuw_bridge_send_invoice( WP_REST_Request $request ) {
	if ( ! function_exists( 'wc_get_order' ) ) {
		return new WP_Error( 'iuw_bridge_woo', 'WooCommerce is required.', array( 'status' => 503 ) );
	}

	$order_id = absint( $request->get_param( 'orderId' ) );
	$order    = wc_get_order( $order_id );
	if ( ! $order ) {
		return new WP_Error( 'iuw_bridge_order', 'Order not found.', array( 'status' => 404 ) );
	}

	// Trigger WooCommerce's own customer invoice email (branded template).
	WC()->mailer()->customer_invoice( $order );
	$order->add_order_note( 'Invoice email triggered by ICE UNDERWATER API bridge.' );

	return array(
		'ok'      => true,
		'orderId' => $order_id,
		'to'      => $order->get_billing_email(),
	);
}

function iuw_bridge_user_payload( WP_User $user ) {
	return array(
		'wpUserId'    => (int) $user->ID,
		'email'       => $user->user_email,
		'displayName' => $user->display_name,
		'roles'       => array_values( $user->roles ),
	);
}
